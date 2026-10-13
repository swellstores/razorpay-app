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

/** The workflow that finishes a new saved card payment, and its params: JSON-safe identifiers only */
export const FINISH_WORKFLOW = 'card-charge-finish';
export type FinishParams = {
  swell_payment_id: string;
  razorpay_order_id: string;
  /** In the currency's smallest unit */
  amount: number;
  currency: string;
  /** The saved card's Razorpay token */
  token: string;
  customer: { id: string; email: string; contact: string };
};

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
 * Captures the payment. On an error it reads the payment again: undefined once it is captured (by this
 * call or an earlier one), otherwise the error and the status read.
 */
async function captureOrRead(charge: Charge, paymentId: string): Promise<{ error: unknown; status: RazorpayPayment['status'] } | undefined> {
  const { razorpay } = charge;
  try {
    await razorpay.capturePayment(paymentId, charge.amount, charge.currency);
  } catch (error) {
    const { status } = await razorpay.getPayment(paymentId);
    return status === 'captured' ? undefined : { error, status };
  }
}

/** Captures the payment, or throws; capturing one already captured is fine, so a retry is safe */
export async function captureSavedPayment(charge: Charge, paymentId: string): Promise<void> {
  const failed = await captureOrRead(charge, paymentId);
  if (failed) throw failed.error;
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
  status ??= (await charge.razorpay.getPayment(paymentId)).status;
  if (status === 'created') return 'pending';
  if (status === 'captured') return { transactionId: paymentId };
  if (status !== 'authorized') return { reason: `Payment is not authorized (status: ${status})` };
  if (!charge.capture) return { transactionId: paymentId };
  const failed = await captureOrRead(charge, paymentId);
  if (!failed) return { transactionId: paymentId };
  if (failed.status === 'authorized' && !isRefusal(failed.error)) throw failed.error;
  return { reason: messageOf(failed.error) };
}

/** What finishing a charge needs of Swell: a function's `req.swell` and a workflow's narrower one both fit */
export interface PaymentsApi {
  get(path: string): Promise<unknown>;
  put(path: string, data: unknown): Promise<unknown>;
}

/** The Swell payment as stored now */
export type SwellPayment = { id: string; captured?: boolean; success?: boolean | null; void?: boolean };

/** The Swell payment a charge is for; the Swell side of a finish needs no Razorpay client */
export type SwellTarget = Pick<Charge, 'swellPaymentId'>;

/** Logs naming the Swell payment and, when there is one, the Razorpay payment */
export function logError(message: string, charge: SwellTarget, paymentId?: string) {
  console.error(message, `(Swell payment ${charge.swellPaymentId}${paymentId ? `, Razorpay payment ${paymentId}` : ''})`);
}

export async function readSwellPayment(swell: PaymentsApi, charge: SwellTarget): Promise<SwellPayment> {
  const record = (await swell.get(`/payments/${charge.swellPaymentId}`)) as Partial<SwellPayment> | null;
  if (!record?.id) {
    throw new Error('The Swell payment could not be read');
  }
  return record as SwellPayment;
}

/**
 * Whether the Swell payment, as stored now, asks for the capture. The hook's snapshot may be stale: the
 * capture of an authorize-phase payment can come while its charge is in flight, and the hook then leaves
 * it to the finish.
 */
export async function wantsCapture(swell: PaymentsApi, charge: SwellTarget): Promise<boolean> {
  return (await readSwellPayment(swell, charge)).captured !== false;
}

/**
 * Writes the Swell payment. A write refused by validation answers `{ errors }` rather than throwing, and
 * one that answers without the payment wrote nothing: both throw.
 */
export async function writePayment(swell: PaymentsApi, charge: SwellTarget, data: Record<string, unknown>): Promise<void> {
  const result = (await swell.put(`/payments/${charge.swellPaymentId}`, data)) as { id?: string; errors?: unknown } | null;
  if (result?.errors) {
    throw new Error(`Could not record the saved card charge: ${JSON.stringify(result.errors)}`);
  }
  if (!result?.id) {
    throw new Error('Could not record the saved card charge: Swell answered without the payment');
  }
}

/**
 * Finishes a Swell payment the charge left pending (`async`). `captured: true` only goes with a capture:
 * on a payment whose record is `captured: false` it would fire the charge again. Throws when the write
 * fails.
 */
export async function recordOutcome(
  swell: PaymentsApi,
  charge: SwellTarget & Pick<Charge, 'capture'>,
  outcome: Outcome,
  paymentId?: string,
): Promise<void> {
  if ('reason' in outcome) {
    logError(`Saved card charge failed: ${outcome.reason}`, charge, paymentId);
    return writePayment(swell, charge, { success: false, error: { message: outcome.reason } });
  }
  return writePayment(swell, charge, { transaction_id: outcome.transactionId, success: true, ...(charge.capture && { captured: true }) });
}

/**
 * Finishes the Swell payment with a saved card payment created for it, by the Swell payment's phase as
 * stored now (the sweep's rules). `status` is the one already known; otherwise the payment is read. A
 * payment still `created` (live pre-debit) is left for a later sweep. After an authorize-only write the
 * Swell payment is read again: a capture that came meanwhile found the charge in flight, so it is
 * captured here, and `captured: true` is safe to write because the record is no longer `captured: false`.
 * Throws when the outcome is unknown or a write fails.
 */
export async function finishSavedPayment(
  swell: PaymentsApi,
  charge: Charge,
  paymentId: string,
  status?: RazorpayPayment['status'],
): Promise<void> {
  status ??= (await charge.razorpay.getPayment(paymentId)).status;
  if (status === 'created') return;
  if (status !== 'authorized' && status !== 'captured') {
    await recordOutcome(swell, charge, { reason: notFinalized(paymentId, `Payment is not authorized (status: ${status})`) }, paymentId);
    return;
  }
  const phase = { ...charge, capture: await wantsCapture(swell, charge) };
  const outcome = await settleSavedPayment(paymentId, phase, status);
  if (outcome === 'pending') return;
  const recorded = 'reason' in outcome ? { reason: notFinalized(paymentId, outcome.reason) } : outcome;
  await recordOutcome(swell, phase, recorded, paymentId);
  if (phase.capture || 'reason' in outcome || !(await wantsCapture(swell, charge))) return;

  const captured = await settleSavedPayment(paymentId, { ...charge, capture: true }, status);
  if (captured !== 'pending' && 'transactionId' in captured) {
    await writePayment(swell, charge, { captured: true });
  } else if (captured !== 'pending') {
    // Its success is already recorded and can not change: support has to capture or void it
    logError(`Saved card payment ${paymentId} was authorized but not captured: ${captured.reason}`, charge, paymentId);
  }
}
