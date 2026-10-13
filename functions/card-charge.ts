import { toSubunits } from '../lib/amount';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Authorize and capture a Razorpay card payment',
  model: {
    events: ['after:payment.charge'],
    fields: ['success', 'error', 'transaction_id'],
  },
};

export default async function (req: SwellRequest) {
  const { amount, currency, captured, intent, transaction_id: transactionId } = req.data;
  const paymentId = intent?.razorpay?.id || transactionId;

  try {
    if (!paymentId) {
      throw new Error('No Razorpay payment for this charge');
    }

    const razorpay = await getRazorpay(req);
    const payment = await razorpay.getPayment(paymentId);
    const expected = toSubunits(amount, currency);

    if (captured === false) {
      if (payment.status !== 'authorized') {
        throw new Error(`Payment is not authorized (status: ${payment.status})`);
      }
      if (payment.amount !== expected || payment.currency !== currency) {
        throw new Error(`Authorized amount ${payment.amount} ${payment.currency} does not match the order amount ${expected} ${currency}`);
      }
    } else if (payment.status === 'authorized') {
      await razorpay.capturePayment(payment.id, expected, currency);
    } else if (payment.status !== 'captured') {
      throw new Error(`Payment is not capturable (status: ${payment.status})`);
    }

    return { success: true, transaction_id: payment.id };
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
