import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Create a Razorpay order for the checkout modal',
  model: { events: ['after:payment.create_intent'], fields: ['result', 'error'] },
};

export default async function (req: SwellRequest) {
  const { amount, currency } = req.data.intent ?? {};

  try {
    if (!Number.isInteger(amount) || amount <= 0 || typeof currency !== 'string') {
      throw new Error('Invalid amount');
    }

    const razorpay = await getRazorpay(req);
    const order = await razorpay.createOrder({
      amount,
      currency,
      payment: { capture: 'manual', capture_options: { manual_expiry_period: 7200, refund_speed: 'normal' } },
    });

    return { result: { order: { id: order.id, amount: order.amount, currency: order.currency } } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
