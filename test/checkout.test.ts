import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('loadRazorpay', () => {
  // A minimal document: the loader only creates, appends and removes <script> elements
  function fakeDocument() {
    const scripts: { src?: string; onload?: () => void; onerror?: () => void; remove(): void }[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      createElement: () => {
        const script = { remove: () => scripts.splice(scripts.indexOf(script), 1) } as (typeof scripts)[number];
        return script;
      },
      head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
    });
    return scripts;
  }

  // A fresh module per test, since the loader caches its pending load
  async function importLoader() {
    vi.resetModules();
    return (await import('../components/lib/checkout')).loadRazorpay;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('adds checkout.js once while a load is pending', async () => {
    const scripts = fakeDocument();
    const loadRazorpay = await importLoader();
    const first = loadRazorpay();
    const second = loadRazorpay();
    expect(scripts.map((script) => script.src)).toEqual(['https://checkout.razorpay.com/v1/checkout.js']);
    (window as any).Razorpay = FakeRazorpay;
    scripts[0].onload?.();
    expect(await first).toBe(FakeRazorpay);
    expect(await second).toBe(FakeRazorpay);
  });

  it('removes a script that failed to load and loads again on the next call', async () => {
    const scripts = fakeDocument();
    const loadRazorpay = await importLoader();
    const failed = loadRazorpay();
    scripts[0].onerror?.();
    await expect(failed).rejects.toThrow('Razorpay checkout could not be loaded');
    expect(scripts.length).toBe(0);

    const retry = loadRazorpay();
    expect(scripts.length).toBe(1);
    (window as any).Razorpay = FakeRazorpay;
    scripts[0].onload?.();
    expect(await retry).toBe(FakeRazorpay);
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
