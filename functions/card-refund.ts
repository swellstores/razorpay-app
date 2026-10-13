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
    const razorpay = await getRazorpay(req);
    const refund = await razorpay.refundPayment(paymentId, toSubunits(amount, currency));
    return { success: true, transaction_id: refund.id };
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
