// Browser side of the Razorpay Standard Checkout; no secrets here
export const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

export interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
}

export interface VerifiedPayment {
  id: string;
  status: string;
  card?: { last4?: string; network?: string };
}

type RazorpayConstructor = new (options: Record<string, unknown>) => {
  on(event: string, handler: (data: { error?: { description?: string } }) => void): void;
  open(): void;
};

/** Loads checkout.js once in the frame's document */
export function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.onload = () => resolve((window as unknown as { Razorpay: RazorpayConstructor }).Razorpay);
    script.onerror = () => reject(new Error('Razorpay checkout could not be loaded'));
    document.head.appendChild(script);
  });
}

/**
 * Opens the card-only Razorpay modal for an order and resolves with the signed response.
 * A failed attempt keeps the modal open with Retry, so it only settles on success or close.
 */
export function openRazorpay(
  Razorpay: RazorpayConstructor,
  { keyId, order, prefill }: { keyId: string; order: RazorpayOrder; prefill?: Record<string, string | undefined> },
): Promise<RazorpayResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastError: string | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };
    const checkout = new Razorpay({
      key: keyId,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      prefill,
      config: {
        display: {
          blocks: { card: { name: 'Pay by card', instruments: [{ method: 'card' }] } },
          sequence: ['block.card'],
          preferences: { show_default_blocks: false },
        },
      },
      handler: (response: RazorpayResponse) => settle(() => resolve(response)),
      modal: { ondismiss: () => settle(() => reject(new Error(lastError || 'Payment cancelled'))) },
    });
    checkout.on('payment.failed', (data) => {
      lastError = data?.error?.description || lastError;
    });
    checkout.open();
  });
}

/** Billing the checkout saves for the verified payment */
export function toBilling(payment: VerifiedPayment) {
  if (payment.status !== 'authorized' && payment.status !== 'captured') {
    throw new Error('Payment was not authorized');
  }
  return {
    billing: {
      card: { token: payment.id, last4: payment.card?.last4, brand: payment.card?.network },
      intent: { razorpay: { id: payment.id } },
    },
  };
}
