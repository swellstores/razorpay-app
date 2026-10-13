import { describe, expect, it } from 'vitest';

import { openRazorpay, toBilling } from '../components/lib/checkout';

class FakeRazorpay {
  static last: FakeRazorpay;
  handlers: Record<string, (data: any) => void> = {};
  constructor(public options: any) { FakeRazorpay.last = this; }
  on(event: string, handler: (data: any) => void) { this.handlers[event] = handler; }
  open() {}
}

const order = { id: 'order_1', amount: 1050, currency: 'INR' };

describe('openRazorpay', () => {
  it('opens a card-only modal for the order and resolves with the handler response', async () => {
    const pending = openRazorpay(FakeRazorpay as any, { keyId: 'rzp_test', order, prefill: { email: 'a@b.c' } });
    const { options } = FakeRazorpay.last;
    expect(options).toMatchObject({ key: 'rzp_test', order_id: 'order_1', amount: 1050, currency: 'INR', prefill: { email: 'a@b.c' } });
    expect(options.config.display.preferences.show_default_blocks).toBe(false);
    options.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 's' });
    await expect(pending).resolves.toEqual({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 's' });
  });

  it('rejects when the shopper closes the modal', async () => {
    const pending = openRazorpay(FakeRazorpay as any, { keyId: 'k', order });
    FakeRazorpay.last.options.modal.ondismiss();
    await expect(pending).rejects.toThrow('Payment cancelled');
  });

  it('keeps waiting after a failed attempt and resolves when the retry succeeds', async () => {
    const pending = openRazorpay(FakeRazorpay as any, { keyId: 'k', order });
    FakeRazorpay.last.handlers['payment.failed']({ error: { description: 'Card declined' } });
    FakeRazorpay.last.options.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_2', razorpay_signature: 's' });
    await expect(pending).resolves.toEqual({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_2', razorpay_signature: 's' });
  });

  it('settles once when the modal closes after a successful payment', async () => {
    const pending = openRazorpay(FakeRazorpay as any, { keyId: 'k', order });
    FakeRazorpay.last.options.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 's' });
    FakeRazorpay.last.options.modal.ondismiss();
    await expect(pending).resolves.toMatchObject({ razorpay_payment_id: 'pay_1' });
  });

  it('rejects with the last failure description when the shopper closes the modal after a failed attempt', async () => {
    const pending = openRazorpay(FakeRazorpay as any, { keyId: 'k', order });
    FakeRazorpay.last.handlers['payment.failed']({ error: { description: 'Card declined' } });
    FakeRazorpay.last.options.modal.ondismiss();
    await expect(pending).rejects.toThrow('Card declined');
  });
});

describe('toBilling', () => {
  it('maps the verified payment to card billing', () => {
    expect(toBilling({ id: 'pay_1', status: 'authorized', card: { last4: '1111', network: 'Visa' } })).toEqual({
      billing: { card: { token: 'pay_1', last4: '1111', brand: 'Visa' }, intent: { razorpay: { id: 'pay_1' } } },
    });
  });

  it('refuses a payment that is not authorized', () => {
    expect(() => toBilling({ id: 'pay_1', status: 'failed' })).toThrow('Payment was not authorized');
  });
});
