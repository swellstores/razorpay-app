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

export interface RazorpayIntent {
  order: RazorpayOrder;
  customer: { id: string };
}

export interface VerifiedPayment {
  id: string;
  status: string;
  token?: {
    id: string;
    card?: { last4?: string; network?: string; expiry_month?: string | number; expiry_year?: string | number };
  };
}

type RazorpayConstructor = new (options: Record<string, unknown>) => {
  on(event: string, handler: (data: { error?: { description?: string } }) => void): void;
  open(): void;
};

let loading: Promise<RazorpayConstructor> | undefined;

/** Loads checkout.js once in the frame's document; a failed load can be retried */
export function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.onload = () => resolve((window as unknown as { Razorpay: RazorpayConstructor }).Razorpay);
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(new Error('Razorpay checkout could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Opens the card-only Razorpay modal for an order, saving the card on the customer, and resolves with the signed response.
 * A failed attempt keeps the modal open with Retry, so it only settles on success or close.
 */
export function openRazorpay(
  Razorpay: RazorpayConstructor,
  { keyId, order, customerId, prefill }: { keyId: string; order: RazorpayOrder; customerId: string; prefill?: Record<string, string | undefined> },
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
      customer_id: customerId,
      recurring: '1',
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

/** A card expiry month or year as a positive whole number, or undefined */
function expiryOf(value: string | number | undefined): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Billing the checkout saves for the verified payment: the saved card token and the payment to finalize */
export function toBilling(payment: VerifiedPayment) {
  if (payment.status !== 'authorized' && payment.status !== 'captured') {
    throw new Error('Payment was not authorized');
  }
  const { token } = payment;
  if (!token?.id) throw new Error('The card could not be saved');
  const { card } = token;
  const expMonth = expiryOf(card?.expiry_month);
  const expYear = expiryOf(card?.expiry_year);
  return {
    billing: {
      card: {
        token: token.id,
        last4: card?.last4,
        brand: card?.network,
        // Left out rather than saved as NaN or 0 when Razorpay has no valid expiry
        ...(expMonth && { exp_month: expMonth }),
        ...(expYear && { exp_year: expYear }),
      },
      intent: { razorpay: { id: payment.id } },
    },
  };
}
