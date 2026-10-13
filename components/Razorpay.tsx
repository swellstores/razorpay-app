import { useEffect, useRef } from 'preact/hooks';
import type { ComponentProps, PaymentContext, PaymentSubmitResult } from '@swell/apps-sdk/components';

import { toSubunits } from '../lib/amount';
import { loadRazorpay, openRazorpay, toBilling } from './lib/checkout';
import type { RazorpayIntent, RazorpayResponse, VerifiedPayment } from './lib/checkout';

export const config = {
  description: 'Razorpay checkout',
  extension: { id: 'card' },
  targets: [{ id: 'checkout.payment.methods' }],
};

interface CheckoutCart {
  capture_total: number;
  currency: string;
  account?: { email?: string; name?: string; phone?: string };
  billing?: { phone?: string };
  shipping?: { phone?: string };
}

/** The phone the shopper gave: an account often has none before its first order */
function contactOf(cart: CheckoutCart): string | undefined {
  return [cart.account?.phone, cart.billing?.phone, cart.shipping?.phone].map((phone) => phone?.trim()).find(Boolean);
}

export default function Razorpay({ context, settings, on, call }: ComponentProps<never, PaymentContext<CheckoutCart>>) {
  // The latest cart for the submit handler, which is registered once
  const latest = useRef(context);
  latest.current = context;
  const keyId = (settings.card as { key_id?: string } | undefined)?.key_id;

  useEffect(() => {
    void loadRazorpay().catch(() => {});
    return on('submit', async (): Promise<PaymentSubmitResult> => {
      if (!keyId) throw new Error('Razorpay is not configured');
      // Load the modal first, so a failed load leaves no Razorpay order behind
      const RazorpayCheckout = await loadRazorpay();
      const { cart } = latest.current;
      const contact = contactOf(cart);
      const { order, customer } = await call<RazorpayIntent>('createIntent', {
        amount: toSubunits(cart.capture_total, cart.currency),
        currency: cart.currency,
        contact,
      });
      const response = await openRazorpay(RazorpayCheckout, {
        keyId,
        order,
        customerId: customer.id,
        prefill: { email: cart.account?.email, name: cart.account?.name, contact },
      });
      const payment = await call<VerifiedPayment>('getIntent', response satisfies RazorpayResponse);
      return toBilling(payment);
    });
  }, [on, call, keyId]);

  return (
    <p style={{ margin: 0, font: '14px/1.5 system-ui, sans-serif', color: '#444' }}>
      You will enter your card details in a secure Razorpay window.
    </p>
  );
}
