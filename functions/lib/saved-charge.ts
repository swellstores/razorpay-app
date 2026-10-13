import { toSubunits } from '../../lib/amount';
import type Razorpay from './razorpay';
import { RazorpayError, type RazorpayOrder, type RazorpayPayment } from './razorpay';

/** What charging a Swell payment needs, shared by the charge and the sweep that finishes it */
export interface Charge {
  razorpay: Razorpay;
  swellPaymentId: string;
  /** In the currency's smallest unit */
  amount: number;
  currency: string;
  /** False in the authorize phase only */
  capture: boolean;
}

/** A transaction id when the charge is done, otherwise why it is not */
export type Outcome = { transactionId: string } | { reason: string };

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Razorpay answered that it will not do it; a network error, a 5xx, a timeout (408) or rate limit (429)
 * leaves the outcome unknown
 */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof RazorpayError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
  );
}

/** The charge of a Swell payment; throws when the payment can not be charged */
export function chargeOf(razorpay: Razorpay, payment: Record<string, unknown>): Charge {
  const swellPaymentId = typeof payment.id === 'string' ? payment.id : '';
  if (!swellPaymentId) {
    throw new Error('No Swell payment for this charge');
  }
  const currency = String(payment.currency ?? '').trim().toUpperCase();
  if (!currency) {
    throw new Error('Invalid currency');
  }
  const amount = toSubunits(Number(payment.amount), currency);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }
  return { razorpay, swellPaymentId, amount, currency, capture: payment.captured !== false };
}

export function mismatchOf(payment: RazorpayPayment, { amount, currency }: Charge): string | undefined {
  if (payment.method !== 'card') {
    return `Payment is not a card payment (method: ${payment.method})`;
  }
  if (payment.amount !== amount || payment.currency !== currency) {
    return `Payment amount ${payment.amount} ${payment.currency} does not match the order amount ${amount} ${currency}`;
  }
}

/** Why a saved card payment did not finish: money may be on hold or taken, so it names the payment */
export function notFinalized(paymentId: string, reason: string): string {
  return `Saved card payment ${paymentId} was not finalized: ${reason}`;
}

/**
 * The saved card payment an attempt of this Swell payment created, found by its order receipt (Swell
 * payment ids are 24 characters, Razorpay takes 40). A captured one comes first, so it is never captured
 * twice; failed and released payments took nothing and are skipped. One still `created` (live recurring
 * debits wait for a pre-debit notification) will take the money later, and one captured that does not
 * match the order took it: the caller must not charge the card again for either. `orders` are the orders
 * with this receipt, which only this app creates.
 */
export async function findSavedPayment(charge: Charge): Promise<{ orders: RazorpayOrder[]; payment?: RazorpayPayment }> {
  const { razorpay, swellPaymentId } = charge;
  const orders = (await razorpay.findOrdersByReceipt(swellPaymentId)).filter((order) => order.receipt === swellPaymentId);
  let authorized: RazorpayPayment | undefined;
  for (const order of orders) {
    for (const payment of await razorpay.getOrderPayments(order.id)) {
      if (payment.status === 'created' || payment.status === 'captured') {
        return { orders, payment };
      }
      if (payment.status === 'authorized' && !mismatchOf(payment, charge)) authorized ??= payment;
    }
  }
  return { orders, payment: authorized };
}

/**
 * Brings a saved card payment to the phase's status: `authorized`, or captured when Swell asks for the
 * capture. Razorpay answers `authorized` after create/recurring and does not capture it for its order, so
 * the capture is explicit. `status` is the one already known (a valid signature means authorized);
 * otherwise the payment is read. It was created by this app for this Swell payment, so there are no owner
 * checks: its notes may be absent. 'pending' while Razorpay still waits to debit it (live pre-debit).
 * Throws when the outcome is unknown: the payment could not be read, or the capture got no answer or a
 * 5xx and the payment is still authorized, so the capture may still land.
 */
export async function settleSavedPayment(
  paymentId: string,
  charge: Charge,
  status?: RazorpayPayment['status'],
): Promise<Outcome | 'pending'> {
  const { razorpay } = charge;
  status ??= (await razorpay.getPayment(paymentId)).status;
  if (status === 'created') return 'pending';
  if (status === 'captured') return { transactionId: paymentId };
  if (status !== 'authorized') return { reason: `Payment is not authorized (status: ${status})` };
  if (!charge.capture) return { transactionId: paymentId };
  try {
    await razorpay.capturePayment(paymentId, charge.amount, charge.currency);
  } catch (error) {
    const now = (await razorpay.getPayment(paymentId)).status;
    if (now === 'captured') return { transactionId: paymentId };
    if (now === 'authorized' && !isRefusal(error)) throw error;
    return { reason: messageOf(error) };
  }
  return { transactionId: paymentId };
}

/** Logs naming the Swell payment and, when there is one, the Razorpay payment */
function logError(message: string, charge: Charge, paymentId?: string) {
  console.error(message, `(Swell payment ${charge.swellPaymentId}${paymentId ? `, Razorpay payment ${paymentId}` : ''})`);
}

/** Writes the Swell payment; a write that fails or answers without the payment is logged, and the sweep heals it */
async function writePayment(req: SwellRequest, charge: Charge, data: Record<string, unknown>, paymentId?: string): Promise<boolean> {
  try {
    const result = await req.swell.put(`/payments/${charge.swellPaymentId}`, data);
    if (result?.errors) throw new Error(JSON.stringify(result.errors));
    if (!result?.id) throw new Error('Swell answered without the payment');
    return true;
  } catch (error) {
    logError(`Could not record the saved card charge (${JSON.stringify(data)}): ${messageOf(error)}`, charge, paymentId);
    return false;
  }
}

/**
 * Finishes a Swell payment the charge left pending (`async`). `captured: true` only goes with a capture:
 * on a payment whose record is `captured: false` it would fire the charge again. Returns whether it was
 * written.
 */
export async function recordOutcome(req: SwellRequest, charge: Charge, outcome: Outcome, paymentId?: string): Promise<boolean> {
  if ('reason' in outcome) {
    logError(`Saved card charge failed: ${outcome.reason}`, charge, paymentId);
    return writePayment(req, charge, { success: false, error: { message: outcome.reason } }, paymentId);
  }
  const data = { transaction_id: outcome.transactionId, success: true, ...(charge.capture && { captured: true }) };
  return writePayment(req, charge, data, paymentId);
}

/**
 * Whether the Swell payment, as stored now, asks for the capture. The hook's snapshot may be stale: the
 * capture of an authorize-phase payment can come while its charge is in flight, and the hook then leaves
 * it to the finish.
 */
async function wantsCapture(req: SwellRequest, charge: Charge): Promise<boolean> {
  const record = await req.swell.get(`/payments/${charge.swellPaymentId}`);
  if (!record?.id) {
    throw new Error('The Swell payment could not be read');
  }
  return record.captured !== false;
}

/**
 * Finishes the Swell payment with a saved card payment created for it, by the Swell payment's phase as
 * stored now. `status` is the one already known; otherwise the payment is read. A payment still `created`
 * (live pre-debit) is left for the sweep. After an authorize-only write the Swell payment is read again:
 * a capture that came meanwhile found the charge in flight, so it is captured here, and `captured: true`
 * is safe to write because the record is no longer `captured: false`. Throws when the outcome is unknown.
 */
export async function finishSavedPayment(
  req: SwellRequest,
  charge: Charge,
  paymentId: string,
  status?: RazorpayPayment['status'],
): Promise<void> {
  status ??= (await charge.razorpay.getPayment(paymentId)).status;
  if (status === 'created') return;
  if (status !== 'authorized' && status !== 'captured') {
    await recordOutcome(req, charge, { reason: notFinalized(paymentId, `Payment is not authorized (status: ${status})`) }, paymentId);
    return;
  }
  const phase = { ...charge, capture: await wantsCapture(req, charge) };
  const outcome = await settleSavedPayment(paymentId, phase, status);
  if (outcome === 'pending') return;
  const recorded = 'reason' in outcome ? { reason: notFinalized(paymentId, outcome.reason) } : outcome;
  const written = await recordOutcome(req, phase, recorded, paymentId);
  if (!written || phase.capture || 'reason' in outcome || !(await wantsCapture(req, charge))) return;

  const captured = await settleSavedPayment(paymentId, { ...charge, capture: true }, status);
  if (captured !== 'pending' && 'transactionId' in captured) {
    await writePayment(req, charge, { captured: true }, paymentId);
  } else if (captured !== 'pending') {
    // Its success is already recorded and can not change: support has to capture or void it
    logError(`Saved card payment ${paymentId} was authorized but not captured: ${captured.reason}`, charge, paymentId);
  }
}
