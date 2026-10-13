import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  extension: 'card',
  description: 'Verify a Razorpay payment from the checkout modal',
  model: { events: ['after:payment.get_intent'], fields: ['result', 'error'] },
};

export default async function (req: SwellRequest) {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.data.intent ?? {};

  try {
    const razorpay = await getRazorpay(req);
    if (!orderId || !paymentId || !signature || !(await razorpay.verifySignature(orderId, paymentId, signature))) {
      throw new Error('Invalid payment signature');
    }

    const payment = await razorpay.getPayment(paymentId, 'token');
    const card = payment.token?.card;
    return {
      result: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        token: payment.token && {
          id: payment.token.id,
          card: { last4: card?.last4, network: card?.network, expiry_month: card?.expiry_month, expiry_year: card?.expiry_year },
        },
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
