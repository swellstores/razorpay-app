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

    const payment = await razorpay.getPayment(paymentId, true);
    return {
      result: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        card: { last4: payment.card?.last4, network: payment.card?.network, type: payment.card?.type },
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
