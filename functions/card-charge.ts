import { toSubunits } from '../lib/amount';
import type Razorpay from './lib/razorpay';
import { RazorpayError, type RazorpayPayment } from './lib/razorpay';
import { customerOf } from './lib/customer';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Capture the shopper authorization, or charge the saved Razorpay card',
  model: {
    events: ['after:payment.charge'],
    fields: ['success', 'error', 'transaction_id'],
  },
};

const FAIL_CLOSED = 'Payment already captured but not recorded; contact support';

interface Charge {
  razorpay: Razorpay;
  swellPaymentId: string;
  /** In the currency's smallest unit */
  amount: number;
  currency: string;
  /** False in the authorize phase only */
  capture: boolean;
}

/** A transaction id when the charge is done, otherwise why the shopper's payment could not finish it */
type Outcome = { transactionId: string } | { reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Razorpay answered that it will not do it; a network error, a 5xx, a timeout (408) or rate limit (429)
 * leaves the outcome unknown
 */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof RazorpayError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
  );
}

function notesOf(payment: RazorpayPayment): Record<string, string> {
  return Array.isArray(payment.notes) ? {} : (payment.notes ?? {});
}

/** The Swell payment whose capture (or saved card charge) took this Razorpay payment */
function ownerOf(payment: RazorpayPayment): string | undefined {
  return notesOf(payment).swell_payment_id;
}

function mismatchOf(payment: RazorpayPayment, { amount, currency }: Charge): string | undefined {
  if (payment.method !== 'card') {
    return `Payment is not a card payment (method: ${payment.method})`;
  }
  if (payment.amount !== amount || payment.currency !== currency) {
    return `Payment amount ${payment.amount} ${payment.currency} does not match the order amount ${amount} ${currency}`;
  }
}

/**
 * What a Razorpay payment is to this charge: 'captured' by this Swell payment, an 'authorized' payment
 * it may use, or the reason it may not. A captured payment that no Swell payment recorded may be this
 * one's own capture whose record was lost, so it fails closed rather than charging again; so does one
 * this Swell payment captured that does not match the order, since its money was already taken.
 */
function standingOf(payment: RazorpayPayment, charge: Charge): 'captured' | 'authorized' | { reason: string } {
  const owner = ownerOf(payment);
  if (payment.status === 'captured') {
    if (owner === charge.swellPaymentId) {
      const mismatch = mismatchOf(payment, charge);
      if (mismatch) throw new Error(mismatch);
      return 'captured';
    }
    if (!owner) throw new Error(FAIL_CLOSED);
    return { reason: 'Payment belongs to another order' };
  }
  if (payment.status !== 'authorized') {
    return { reason: `Payment is not authorized (status: ${payment.status})` };
  }
  if (owner && owner !== charge.swellPaymentId) {
    return { reason: 'Payment belongs to another order' };
  }
  const mismatch = mismatchOf(payment, charge);
  return mismatch ? { reason: mismatch } : 'authorized';
}

/** Captures the authorization; the capture is the claim, recorded on the payment once it succeeded */
async function captureAndClaim(payment: RazorpayPayment, charge: Charge): Promise<Outcome> {
  const { razorpay, swellPaymentId } = charge;
  try {
    await razorpay.capturePayment(payment.id, charge.amount, charge.currency);
  } catch (error) {
    const standing = standingOf(await razorpay.getPayment(payment.id), charge);
    if (standing === 'captured') return { transactionId: payment.id };
    // Still authorized: the saved card is charged only when Razorpay refused the capture. After a network
    // error or a 5xx the capture may still land, so the charge fails rather than risk taking the money twice;
    // the merchant retries it
    if (standing === 'authorized' && !isRefusal(error)) throw error;
    return { reason: messageOf(error) };
  }
  if (ownerOf(payment) !== swellPaymentId) {
    try {
      await razorpay.updatePayment(payment.id, { notes: { ...notesOf(payment), swell_payment_id: swellPaymentId } });
    } catch (error) {
      // The money is this Swell payment's either way: report the capture, and leave the record to support
      console.error(`Captured ${payment.id} for ${swellPaymentId} but could not record it:`, error);
    }
  }
  return { transactionId: payment.id };
}

/** Finishes the charge with the shopper's Razorpay payment when it is valid and this Swell payment's */
async function chargeShopperPayment(paymentId: string, charge: Charge): Promise<Outcome> {
  const payment = await charge.razorpay.getPayment(paymentId);
  const standing = standingOf(payment, charge);
  if (standing === 'captured') return { transactionId: payment.id };
  if (standing !== 'authorized') return standing;
  return charge.capture ? captureAndClaim(payment, charge) : { transactionId: payment.id };
}

/**
 * Brings a saved card payment to the phase's status. Razorpay answers `authorized` right after
 * create/recurring, so the capture is explicit; it may also have captured it already. It was created here
 * for this Swell payment, now or in an earlier attempt found by its order receipt, so no owner checks:
 * its notes may be absent.
 */
async function finalizeSavedPayment(paymentId: string, charge: Charge): Promise<void> {
  const { razorpay } = charge;
  const { status } = await razorpay.getPayment(paymentId);
  if (status === 'captured') return;
  if (status !== 'authorized') {
    throw new Error(`Payment is not authorized (status: ${status})`);
  }
  if (!charge.capture) return;
  try {
    await razorpay.capturePayment(paymentId, charge.amount, charge.currency);
  } catch (error) {
    if ((await razorpay.getPayment(paymentId)).status !== 'captured') throw error;
  }
}

/**
 * The saved card payment an earlier attempt of this Swell payment created, found by its order receipt:
 * after a lost answer, a retry finalizes it rather than charging the card again. A captured one comes
 * first, so it is never captured twice; failed and released payments took nothing. One still `created`
 * (live recurring debits wait for a pre-debit notification) will take the money later, and one it
 * captured that does not match the order took it: both fail rather than charge the card again.
 */
async function findSavedPayment(charge: Charge): Promise<string | undefined> {
  const { razorpay, swellPaymentId } = charge;
  const orders = await razorpay.findOrdersByReceipt(swellPaymentId);
  let authorized: string | undefined;
  for (const order of orders.filter((order) => order.receipt === swellPaymentId)) {
    for (const payment of await razorpay.getOrderPayments(order.id)) {
      if (payment.status === 'created') {
        throw new Error(`Saved card payment ${payment.id} is still pending (status: created); contact support`);
      }
      if (payment.status !== 'authorized' && payment.status !== 'captured') continue;
      const mismatch = mismatchOf(payment, charge);
      if (payment.status === 'captured') {
        if (mismatch) throw new Error(mismatch);
        return payment.id;
      }
      if (!mismatch) authorized ??= payment.id;
    }
  }
  return authorized;
}

type Customer = { id: string; email: string; contact: string };

/**
 * Charges the saved card token with a new payment on `orderId`, bound to this Swell payment at creation.
 * Razorpay answers a successful one with the order's signature, so it is not read back; without a valid
 * signature it is read, and must be authorized or captured.
 */
async function createSavedPayment(customer: Customer, token: string, orderId: string, charge: Charge): Promise<string> {
  const { razorpay, swellPaymentId, amount, currency } = charge;
  const answer = await razorpay.createRecurringPayment({
    email: customer.email,
    contact: customer.contact,
    amount,
    currency,
    order_id: orderId,
    customer_id: customer.id,
    token,
    recurring: '1',
    notes: { swell_payment_id: swellPaymentId },
  });
  const paymentId = answer.razorpay_payment_id;
  try {
    if (!(await razorpay.verifySignature(orderId, paymentId, answer.razorpay_signature ?? ''))) {
      const { status } = await razorpay.getPayment(paymentId);
      if (status !== 'authorized' && status !== 'captured') {
        throw new Error(`Payment is not authorized (status: ${status})`);
      }
    }
  } catch (error) {
    throw new SavedPaymentError(paymentId, error);
  }
  return paymentId;
}

/** A saved card payment exists but did not finish: money may be on hold or taken, so it names the payment */
class SavedPaymentError extends Error {
  constructor(paymentId: string, cause: unknown) {
    super(`Saved card payment ${paymentId} was not finalized: ${messageOf(cause)}`);
  }
}

/**
 * Charges the saved card. The platform gives the whole charge 10 seconds and each Razorpay call takes
 * about 2, so everything that can runs in parallel: the customer, the payment of an earlier attempt and
 * the order for a new one. A new payment is never captured separately: when Swell asks for the capture
 * its order captures it (`payment_capture`), and the payment counts once it is authorized.
 */
async function chargeSavedCard(req: SwellRequest, token: string, charge: Charge): Promise<string> {
  const { razorpay, swellPaymentId, amount, currency } = charge;
  const accountId = req.data.account_id;
  if (!accountId) {
    throw new Error('No account for this charge');
  }
  const [customer, earlier, order] = await Promise.allSettled([
    customerOf(req, razorpay, accountId, 'charge the saved card'),
    findSavedPayment(charge),
    // The receipt finds this order again on a retry (Swell payment ids are 24 characters, Razorpay takes 40);
    // an order left unused when an earlier attempt is found expires on its own
    razorpay.createOrder({
      amount,
      currency,
      payment_capture: charge.capture,
      receipt: swellPaymentId,
      notes: { swell_payment_id: swellPaymentId },
    }),
  ]);
  try {
    // A failed lookup fails the charge: a new payment is created only when no earlier one took the money
    if (earlier.status === 'rejected') throw earlier.reason;
    if (earlier.value) {
      try {
        await finalizeSavedPayment(earlier.value, charge);
      } catch (error) {
        throw new SavedPaymentError(earlier.value, error);
      }
      return earlier.value;
    }
    if (customer.status === 'rejected') throw customer.reason;
    if (order.status === 'rejected') throw order.reason;
    return await createSavedPayment(customer.value, token, order.value.id, charge);
  } catch (error) {
    if (error instanceof SavedPaymentError) {
      console.error(error.message, `(Swell payment ${swellPaymentId})`);
    }
    throw error;
  }
}

export default async function (req: SwellRequest) {
  // `id` is the Swell payment record being charged, in both phases
  const { id: swellPaymentId, captured } = req.data;
  const currency = String(req.data.currency ?? '').trim().toUpperCase();
  // The authorize phase's result first: the intent is the shopper's original authorization
  const paymentId = req.data.transaction_id || req.data.intent?.razorpay?.id;
  const token = req.data.card?.token;

  try {
    if (!swellPaymentId) {
      throw new Error('No Swell payment for this charge');
    }
    if (!currency) {
      throw new Error('Invalid currency');
    }
    const amount = toSubunits(Number(req.data.amount), currency);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Invalid amount');
    }

    const charge: Charge = { razorpay: await getRazorpay(req), swellPaymentId, amount, currency, capture: captured !== false };
    let reason = 'No Razorpay payment or saved card for this charge';
    if (paymentId) {
      const outcome = await chargeShopperPayment(paymentId, charge);
      if ('transactionId' in outcome) return { success: true, transaction_id: outcome.transactionId };
      reason = outcome.reason;
    }
    if (!token) {
      throw new Error(reason);
    }
    return { success: true, transaction_id: await chargeSavedCard(req, token, charge) };
  } catch (error) {
    return { success: false, error: { message: messageOf(error) } };
  }
}
