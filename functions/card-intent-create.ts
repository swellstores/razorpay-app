import { contactOf } from './lib/customer';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Create a Razorpay customer and token order for the checkout modal',
  model: { events: ['after:payment.create_intent'], fields: ['result', 'error'] },
};

export default async function (req: SwellRequest) {
  const { amount, currency } = req.data.intent ?? {};
  const account = req.data.account ?? {};

  try {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Invalid amount');
    }
    if (typeof currency !== 'string' || !currency.trim()) {
      throw new Error('Invalid currency');
    }

    const email = typeof account.email === 'string' ? account.email.trim() : '';
    if (!email) {
      throw new Error('An email address is required to save the card');
    }
    const contact = contactOf(account);
    if (!contact) {
      throw new Error('A phone number is required to save the card');
    }

    const razorpay = await getRazorpay(req);
    const customer = await razorpay.createCustomer({
      name: account.name,
      email,
      contact,
      fail_existing: '0', // Returns the existing customer when the same details were saved before
    });
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
