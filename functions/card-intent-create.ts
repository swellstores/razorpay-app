import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Create a Razorpay order for the checkout modal',
  model: { events: ['after:payment.create_intent'], fields: ['result', 'error'] },
};

export default async function (req: SwellRequest) {
  const { amount, currency } = req.data.intent ?? {};

  try {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Invalid amount');
    }
    if (typeof currency !== 'string' || !currency.trim()) {
      throw new Error('Invalid currency');
    }

    const razorpay = await getRazorpay(req);
    const order = await razorpay.createOrder({
      amount,
      currency: currency.trim().toUpperCase(),
      // Swell captures right after authorizing: a short window (minutes) limits stranded holds
      payment: { capture: 'manual', capture_options: { manual_expiry_period: 60, refund_speed: 'normal' } },
    });

    return { result: { order: { id: order.id, amount: order.amount, currency: order.currency } } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
