import { toSubunits } from '../lib/amount';
import type Razorpay from './lib/razorpay';
import type { RazorpayPayment } from './lib/razorpay';
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
 * one's own capture whose record was lost, so it fails closed rather than charging again.
 */
function standingOf(payment: RazorpayPayment, charge: Charge): 'captured' | 'authorized' | { reason: string } {
  const owner = ownerOf(payment);
  if (payment.status === 'captured') {
    if (owner === charge.swellPaymentId) return 'captured';
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
    return { reason: error instanceof Error ? error.message : String(error) };
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

/** The Razorpay customer the card was saved for, from the Swell account */
async function customerOf(req: SwellRequest, razorpay: Razorpay) {
  const accountId = req.data.account_id;
  if (!accountId) {
    throw new Error('No account for this charge');
  }
  const account = (await req.swell.get(`/accounts/${accountId}`)) ?? {};
  const email = typeof account.email === 'string' ? account.email.trim() : '';
  if (!email) {
    throw new Error('An email address is required to charge the saved card');
  }
  const contact = account.phone || account.billing?.phone || req.data.billing?.phone || account.shipping?.phone;
  if (!contact) {
    throw new Error('A phone number is required to charge the saved card');
  }
  // Returns the existing customer when the same details were saved before
  const customer = await razorpay.createCustomer({ name: account.name, email, contact, fail_existing: '0' });
  return { id: customer.id, email, contact };
}

/** Charges the saved card token with a new payment, bound to this Swell payment at creation */
async function chargeSavedCard(req: SwellRequest, token: string, charge: Charge): Promise<string> {
  const { razorpay, amount, currency } = charge;
  const customer = await customerOf(req, razorpay);
  const notes = { swell_payment_id: charge.swellPaymentId };
  const order = await razorpay.createOrder({ amount, currency, payment_capture: charge.capture, notes });
  const { razorpay_payment_id: paymentId } = await razorpay.createRecurringPayment({
    email: customer.email,
    contact: customer.contact,
    amount,
    currency,
    order_id: order.id,
    customer_id: customer.id,
    token,
    recurring: '1',
    notes,
  });
  const payment = await razorpay.getPayment(paymentId);
  const expected = charge.capture ? 'captured' : 'authorized';
  if (payment.status !== expected) {
    throw new Error(`Saved card payment ${payment.id} is not ${expected} (status: ${payment.status})`);
  }
  return payment.id;
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
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
