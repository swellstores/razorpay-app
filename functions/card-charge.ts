import type { RazorpayPayment } from './lib/razorpay';
import { customerOf } from './lib/customer';
import {
  type Charge,
  chargeOf,
  type FinishParams,
  findSavedPayment,
  FINISH_WORKFLOW,
  isRefusal,
  messageOf,
  mismatchOf,
  notFinalized,
  type Outcome,
  settleSavedPayment,
} from './lib/saved-charge';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Capture the shopper authorization, or charge the saved Razorpay card',
  model: {
    events: ['after:payment.charge'],
    fields: ['success', 'error', 'transaction_id', 'async'],
  },
};

const FAIL_CLOSED = 'Payment already captured but not recorded; contact support';
const NO_LONGER_VALID = 'The authorization is no longer valid; charge the saved card with a new payment';

function notesOf(payment: RazorpayPayment): Record<string, string> {
  return Array.isArray(payment.notes) ? {} : (payment.notes ?? {});
}

/** The Swell payment whose capture (or saved card charge) took this Razorpay payment */
function ownerOf(payment: RazorpayPayment): string | undefined {
  return notesOf(payment).swell_payment_id;
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
 * Finishes the saved card payment of an earlier attempt of this Swell payment, found by its order receipt:
 * after a lost answer, a retry finalizes it rather than charging the card again. One still `created` will
 * take the money later, and one captured that does not match the order took it: both fail rather than
 * charge the card again. At most a read and a capture, so it fits in the hook.
 */
async function finishEarlierPayment(payment: RazorpayPayment, charge: Charge): Promise<string> {
  if (payment.status === 'created') {
    throw new Error(`Saved card payment ${payment.id} is still pending (status: created); contact support`);
  }
  const mismatch = payment.status === 'captured' && mismatchOf(payment, charge);
  if (mismatch) throw new Error(mismatch);
  let outcome: Outcome | 'pending';
  try {
    outcome = await settleSavedPayment(payment.id, charge);
  } catch (error) {
    outcome = { reason: messageOf(error) };
  }
  if (outcome === 'pending') outcome = { reason: 'Payment is not authorized (status: created)' };
  if ('reason' in outcome) {
    const message = notFinalized(payment.id, outcome.reason);
    console.error(message, `(Swell payment ${charge.swellPaymentId})`);
    throw new Error(message);
  }
  return outcome.transactionId;
}

/**
 * Charges the saved card. The platform gives the whole charge 10 seconds and each Razorpay call takes
 * about 2, so everything that can runs in parallel: the customer, the payment of an earlier attempt and
 * the order for a new one. An earlier payment is finished here. A new one is charged by the
 * `card-charge-finish` workflow, since create/recurring alone takes more than 6 seconds, and the Swell
 * payment stays pending (`async`) until the workflow records it. The order never captures it (Razorpay
 * leaves a recurring payment authorized whatever `payment_capture` says), so the capture is explicit.
 */
async function chargeSavedCard(req: SwellRequest, token: string, charge: Charge) {
  const { razorpay, swellPaymentId, amount, currency } = charge;
  const accountId = req.data.account_id;
  if (!accountId) {
    throw new Error('No account for this charge');
  }
  const [customer, earlier, order] = await Promise.allSettled([
    customerOf(req, razorpay, accountId, 'charge the saved card'),
    findSavedPayment(charge),
    // The receipt finds this order again on a retry and in the sweep; an order left unused when an earlier
    // attempt is found expires on its own
    razorpay.createOrder({
      amount,
      currency,
      payment_capture: false,
      receipt: swellPaymentId,
      notes: { swell_payment_id: swellPaymentId },
    }),
  ]);
  // A failed lookup fails the charge: a new payment is created only when no earlier one took the money
  if (earlier.status === 'rejected') throw earlier.reason;
  if (earlier.value.payment) {
    return { success: true, transaction_id: await finishEarlierPayment(earlier.value.payment, charge) };
  }
  if (customer.status === 'rejected') throw customer.reason;
  if (order.status === 'rejected') throw order.reason;
  // Identifiers only: the workflow reads the keys from the settings, and the capture from the Swell payment.
  // A failure to start it fails the charge: nothing was charged, only an unused order exists
  const params: FinishParams = {
    swell_payment_id: swellPaymentId,
    razorpay_order_id: order.value.id,
    amount,
    currency,
    token,
    customer: { id: customer.value.id, email: customer.value.email, contact: customer.value.contact },
  };
  await req.swell.workflows.create(FINISH_WORKFLOW, params);
  return { async: true };
}

export default async function (req: SwellRequest) {
  // The authorize phase's result first: the intent is the shopper's original authorization
  const paymentId = req.data.transaction_id || req.data.intent?.razorpay?.id;
  const token = req.data.card?.token;
  // The Swell payment as stored before this charge; absent when it is being created
  const record = req.data.$record;

  try {
    // `id` is the Swell payment record being charged, in both phases
    const charge = chargeOf(await getRazorpay(req), req.data);
    // A saved card charge of this Swell payment is in flight (the capture came right after an authorize
    // phase that answered async): it reads the capture from the record when it finishes
    if (record?.async === true && record.success == null) {
      return { async: true };
    }
    let reason = 'No Razorpay payment or saved card for this charge';
    if (paymentId) {
      const outcome = await chargeShopperPayment(paymentId, charge);
      if ('transactionId' in outcome) return { success: true, transaction_id: outcome.transactionId };
      reason = outcome.reason;
    }
    if (!token) {
      throw new Error(reason);
    }
    // A pending charge would leave a Swell payment that already has its result (a capture days after the
    // authorization) recorded as paid without the money: the merchant charges the card with a new payment
    if (record && record.success != null) {
      throw new Error(NO_LONGER_VALID);
    }
    return await chargeSavedCard(req, token, charge);
  } catch (error) {
    return { success: false, error: { message: messageOf(error) } };
  }
}
