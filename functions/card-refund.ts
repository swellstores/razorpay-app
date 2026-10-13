import { toSubunits } from '../lib/amount';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Refund a Razorpay card payment',
  model: { events: ['after:payment.refund'], fields: ['success', 'error', 'transaction_id'] },
};

export default async function (req: SwellRequest) {
  const { amount, currency, transaction_id: paymentId } = req.data;

  try {
    if (!paymentId) {
      throw new Error('No Razorpay payment to refund');
    }
    if (typeof amount !== 'number' || !(amount > 0)) {
      throw new Error('Refund amount must be greater than zero');
    }

    const razorpay = await getRazorpay(req);
    const refund = await razorpay.refundPayment(paymentId, toSubunits(amount, currency));
    return { success: true, transaction_id: refund.id };
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
