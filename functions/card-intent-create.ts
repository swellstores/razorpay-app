import { customerOf } from './lib/customer';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Create a Razorpay customer and token order for the checkout modal',
  model: { events: ['after:payment.create_intent'], fields: ['result', 'error'] },
};

export default async function (req: SwellRequest) {
  const { amount, currency } = req.data.intent ?? {};
  const accountId = req.data.account?.id || req.data.account_id;

  try {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Invalid amount');
    }
    if (typeof currency !== 'string' || !currency.trim()) {
      throw new Error('Invalid currency');
    }
    if (!accountId) {
      throw new Error('No account for this checkout');
    }

    const razorpay = await getRazorpay(req);
    // The account as stored, as the charge loads it: the request's copy may lack the phone
    const customer = await customerOf(req, razorpay, accountId, 'save the card');
    // Built from the amount and currency only: the rest of the intent comes from the browser
    const order = await razorpay.createOrder({
      amount,
      currency: currency.trim().toUpperCase(),
      customer_id: customer.id,
      method: 'card',
      token: { max_amount: 1000000, frequency: 'as_presented' },
      // 7200 minutes (5 days) is Razorpay's maximum: a merchant can capture later
      payment: { capture: 'manual', capture_options: { manual_expiry_period: 7200, refund_speed: 'normal' } },
    });

    return { result: { order: { id: order.id, amount: order.amount, currency: order.currency }, customer: { id: customer.id } } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
