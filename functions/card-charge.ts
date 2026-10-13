import { toSubunits } from '../lib/amount';
import type Razorpay from './lib/razorpay';
import type { RazorpayPayment } from './lib/razorpay';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Authorize and capture a Razorpay card payment',
  model: {
    events: ['after:payment.charge'],
    fields: ['success', 'error', 'transaction_id'],
  },
};

function notesOf(payment: RazorpayPayment): Record<string, string> {
  return Array.isArray(payment.notes) ? {} : (payment.notes ?? {});
}

/** The Swell payment a Razorpay payment was bound to by an earlier charge */
function boundTo(payment: RazorpayPayment): string | undefined {
  return notesOf(payment).swell_payment_id;
}

/** Checks every phase repeats: the browser chooses which Razorpay payment the charge reads */
function assertPaymentMatches(payment: RazorpayPayment, amount: number, currency: string) {
  if (payment.method !== 'card') {
    throw new Error(`Payment is not a card payment (method: ${payment.method})`);
  }
  if (payment.amount !== amount || payment.currency !== currency) {
    throw new Error(`Payment amount ${payment.amount} ${payment.currency} does not match the order amount ${amount} ${currency}`);
  }
}

/** Binds an authorized payment to one Swell payment, so no other order can use it */
async function bindPayment(razorpay: Razorpay, payment: RazorpayPayment, swellPaymentId: string) {
  const owner = boundTo(payment);
  if (owner === swellPaymentId) return;
  if (owner) {
    throw new Error('Payment belongs to another order');
  }
  await razorpay.updatePayment(payment.id, { notes: { ...notesOf(payment), swell_payment_id: swellPaymentId } });
}

/** Captures the payment; a failed capture still succeeds when this Swell payment captured it meanwhile */
async function capturePayment(razorpay: Razorpay, payment: RazorpayPayment, swellPaymentId: string, amount: number, currency: string) {
  try {
    await razorpay.capturePayment(payment.id, amount, currency);
  } catch (error) {
    const current = await razorpay.getPayment(payment.id);
    if (current.status !== 'captured' || boundTo(current) !== swellPaymentId) {
      throw error;
    }
  }
}

export default async function (req: SwellRequest) {
  // `id` is the Swell payment record being charged, in both phases
  const { id: swellPaymentId, amount, captured, intent, transaction_id: transactionId } = req.data;
  const currency = String(req.data.currency ?? '').toUpperCase();
  const paymentId = intent?.razorpay?.id || transactionId;

  try {
    if (!paymentId) {
      throw new Error('No Razorpay payment for this charge');
    }
    if (!swellPaymentId) {
      throw new Error('No Swell payment for this charge');
    }

    const razorpay = await getRazorpay(req);
    const payment = await razorpay.getPayment(paymentId);
    const expected = toSubunits(amount, currency);
    assertPaymentMatches(payment, expected, currency);

    if (captured === false) {
      if (payment.status !== 'authorized') {
        throw new Error(`Payment is not authorized (status: ${payment.status})`);
      }
      await bindPayment(razorpay, payment, swellPaymentId);
    } else if (payment.status === 'authorized') {
      await bindPayment(razorpay, payment, swellPaymentId);
      await capturePayment(razorpay, payment, swellPaymentId, expected, currency);
    } else if (payment.status === 'captured') {
      // Only a retry of the Swell payment that captured it
      if (boundTo(payment) !== swellPaymentId) {
        throw new Error('Payment belongs to another order');
      }
    } else {
      throw new Error(`Payment is not capturable (status: ${payment.status})`);
    }

    return { success: true, transaction_id: payment.id };
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
