import { afterEach, describe, expect, it, vi } from 'vitest';

import charge from '../functions/card-charge';

const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };

function request(data: Record<string, unknown>) {
  return { appId: 'razorpay', data, swell: { settings: vi.fn(async () => settings) } } as any;
}

/**
 * Fake Razorpay payments API around one payment: GET returns it, PATCH updates its notes,
 * capture marks it captured. `capture: 'race'` captures it but answers with an error,
 * as when another call captured it first; `capture: 'error'` fails and leaves it authorized.
 */
function mockRazorpay(payment: Record<string, unknown>, { capture }: { capture?: 'race' | 'error' } = {}) {
  let current = { ...payment };
  const calls: { url: string; method: string; body?: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'PATCH') {
      current = { ...current, notes: body.notes };
    } else if (url.endsWith('/capture')) {
      if (capture === 'error') return new Response('{"error":{"description":"Gateway timeout"}}', { status: 502 });
      current = { ...current, status: 'captured' };
      if (capture === 'race') return new Response('{"error":{"description":"This payment has already been captured"}}', { status: 400 });
    }
    return Response.json(current);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const base = { id: 'swell_pay_1', amount: 10.5, currency: 'INR', intent: { razorpay: { id: 'pay_1' } } };
// Razorpay returns empty notes as an empty array
const authorized = { id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR', method: 'card', notes: [] };
const bound = { ...authorized, notes: { swell_payment_id: 'swell_pay_1' } };
const capturedBound = { ...bound, status: 'captured' };

const failure = (message: string) => ({ success: false, error: { message } });

describe('payment.charge', () => {
  describe('authorize phase', () => {
    it('binds the authorized payment to the Swell payment without capturing it', async () => {
      const calls = mockRazorpay(authorized);
      expect(await charge(request({ ...base, captured: false }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map(({ method, url, body }) => [method, url, body])).toEqual([
        ['GET', 'https://api.razorpay.com/v1/payments/pay_1', undefined],
        ['PATCH', 'https://api.razorpay.com/v1/payments/pay_1', { notes: { swell_payment_id: 'swell_pay_1' } }],
      ]);
    });

    it('keeps the payment notes it already has when binding', async () => {
      const calls = mockRazorpay({ ...authorized, notes: { cart: 'c1' } });
      await charge(request({ ...base, captured: false }));
      expect(calls[1].body).toEqual({ notes: { cart: 'c1', swell_payment_id: 'swell_pay_1' } });
    });

    it('accepts a payment already bound to this Swell payment without writing again', async () => {
      const calls = mockRazorpay(bound);
      expect(await charge(request({ ...base, captured: false }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('fails for an authorized payment bound to another Swell payment', async () => {
      const calls = mockRazorpay({ ...authorized, notes: { swell_payment_id: 'swell_pay_other' } });
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure('Payment belongs to another order'));
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('fails when the amount differs', async () => {
      mockRazorpay({ ...authorized, amount: 999 });
      expect(await charge(request({ ...base, captured: false }))).toEqual(
        failure('Payment amount 999 INR does not match the order amount 1050 INR'),
      );
    });

    it('fails when the currency differs', async () => {
      mockRazorpay({ ...authorized, currency: 'USD' });
      expect(await charge(request({ ...base, captured: false }))).toEqual(
        failure('Payment amount 1050 USD does not match the order amount 1050 INR'),
      );
    });

    it('compares the Swell currency in upper case', async () => {
      mockRazorpay(bound);
      expect(await charge(request({ ...base, currency: 'inr', captured: false }))).toEqual({ success: true, transaction_id: 'pay_1' });
    });

    it('fails for a payment that is not a card payment', async () => {
      const calls = mockRazorpay({ ...authorized, method: 'upi' });
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure('Payment is not a card payment (method: upi)'));
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('fails when the payment is not authorized', async () => {
      mockRazorpay({ ...authorized, status: 'failed' });
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure('Payment is not authorized (status: failed)'));
    });

    it('fails for an already captured payment', async () => {
      mockRazorpay(capturedBound);
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure('Payment is not authorized (status: captured)'));
    });
  });

  describe('capture phase', () => {
    it('captures a payment bound to this Swell payment', async () => {
      const calls = mockRazorpay(bound);
      expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map(({ method, url, body }) => [method, url, body])).toEqual([
        ['GET', 'https://api.razorpay.com/v1/payments/pay_1', undefined],
        ['POST', 'https://api.razorpay.com/v1/payments/pay_1/capture', { amount: 1050, currency: 'INR' }],
      ]);
    });

    it('binds an unbound authorized payment before capturing it', async () => {
      const calls = mockRazorpay(authorized);
      expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map(({ method, body }) => [method, body])).toEqual([
        ['GET', undefined],
        ['PATCH', { notes: { swell_payment_id: 'swell_pay_1' } }],
        ['POST', { amount: 1050, currency: 'INR' }],
      ]);
    });

    it('treats a missing captured flag as a capture request', async () => {
      const calls = mockRazorpay(bound);
      await charge(request(base));
      expect(calls.at(-1)?.url).toBe('https://api.razorpay.com/v1/payments/pay_1/capture');
    });

    it('does not capture an authorized payment bound to another Swell payment', async () => {
      const calls = mockRazorpay({ ...authorized, notes: { swell_payment_id: 'swell_pay_other' } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Payment belongs to another order'));
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('does not capture an authorized payment of another amount', async () => {
      const calls = mockRazorpay({ ...bound, amount: 999 });
      expect(await charge(request({ ...base, captured: true }))).toEqual(
        failure('Payment amount 999 INR does not match the order amount 1050 INR'),
      );
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('succeeds without a second capture when this Swell payment already captured it', async () => {
      const calls = mockRazorpay(capturedBound);
      expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('fails for a captured payment of another amount', async () => {
      mockRazorpay({ ...capturedBound, amount: 500 });
      expect(await charge(request({ ...base, captured: true }))).toEqual(
        failure('Payment amount 500 INR does not match the order amount 1050 INR'),
      );
    });

    it('fails for a captured payment bound to another Swell payment', async () => {
      mockRazorpay({ ...capturedBound, notes: { swell_payment_id: 'swell_pay_other' } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Payment belongs to another order'));
    });

    it('fails for a captured payment without a binding', async () => {
      const calls = mockRazorpay({ ...authorized, status: 'captured' });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Payment belongs to another order'));
      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('fails for a captured payment that is not a card payment', async () => {
      mockRazorpay({ ...capturedBound, method: 'netbanking' });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Payment is not a card payment (method: netbanking)'));
    });

    it('recovers when another call captured the payment first', async () => {
      const calls = mockRazorpay(bound, { capture: 'race' });
      expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
      expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    });

    it('fails with the capture error when the payment is still not captured', async () => {
      mockRazorpay(bound, { capture: 'error' });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Razorpay: Gateway timeout'));
    });

    it('fails for a payment that is neither authorized nor captured', async () => {
      mockRazorpay({ ...bound, status: 'refunded' });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Payment is not capturable (status: refunded)'));
    });
  });

  it('uses the transaction id when the intent is gone', async () => {
    const calls = mockRazorpay({ ...capturedBound, id: 'pay_2' });
    const { intent, ...data } = base;
    await charge(request({ ...data, captured: true, transaction_id: 'pay_2' }));
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_2');
  });

  it('fails without a Razorpay payment', async () => {
    expect(await charge(request({ id: 'swell_pay_1', amount: 1, currency: 'INR', captured: false }))).toEqual(
      failure('No Razorpay payment for this charge'),
    );
  });

  it('fails without the Swell payment id, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { id, ...data } = base;
    expect(await charge(request({ ...data, captured: false }))).toEqual(failure('No Swell payment for this charge'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns Razorpay API errors into the failure contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"description":"Bad request"}}', { status: 400 })));
    expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Razorpay: Bad request'));
  });
});
