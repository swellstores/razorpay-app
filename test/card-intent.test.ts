import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import createIntent from '../functions/card-intent-create';
import getIntent from '../functions/card-intent-get';

const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };
const request = (data: Record<string, unknown>) => ({ appId: 'razorpay', data, swell: { settings: vi.fn(async () => settings) } }) as any;

afterEach(() => vi.unstubAllGlobals());

const account = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+911234567890', billing: { phone: '+910000000001' }, shipping: { phone: '+910000000002' } };

const ORDER_BODY = (amount: number, currency: string) => ({
  amount,
  currency,
  customer_id: 'cust_1',
  method: 'card',
  token: { max_amount: 1000000, frequency: 'as_presented' },
  payment: { capture: 'manual', capture_options: { manual_expiry_period: 7200, refund_speed: 'normal' } },
});

/** Answers /customers and /orders and records every call */
function stubRazorpay() {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.endsWith('/customers')) return Response.json({ id: 'cust_1', email: body.email });
    return Response.json({ id: 'order_1', amount: body.amount, currency: body.currency });
  }));
  return calls;
}

describe('payment.create_intent', () => {
  it('creates the Razorpay customer, then a token order for it', async () => {
    const calls = stubRazorpay();
    expect(await createIntent(request({ account, intent: { amount: 1050, currency: 'INR' } }))).toEqual({
      result: { order: { id: 'order_1', amount: 1050, currency: 'INR' }, customer: { id: 'cust_1' } },
    });
    expect(calls.map((call) => call.url)).toEqual(['https://api.razorpay.com/v1/customers', 'https://api.razorpay.com/v1/orders']);
    expect(calls[0].body).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', contact: '+911234567890', fail_existing: '0' });
    expect(calls[1].body).toEqual(ORDER_BODY(1050, 'INR'));
  });

  it.each([
    ['the billing phone', { name: 'A', email: 'a@b.c', billing: { phone: '+91b' }, shipping: { phone: '+91s' } }, '+91b'],
    ['the shipping phone', { name: 'A', email: 'a@b.c', shipping: { phone: '+91s' } }, '+91s'],
  ])('falls back to %s as the contact', async (_name, shopper, contact) => {
    const calls = stubRazorpay();
    await createIntent(request({ account: shopper, intent: { amount: 1050, currency: 'INR' } }));
    expect(calls[0].body.contact).toBe(contact);
  });

  it('builds the order from the amount and currency only, ignoring other intent fields', async () => {
    const calls = stubRazorpay();
    await createIntent(request({ account, intent: { amount: 1050, currency: 'inr', customer_id: 'cust_evil', token: { max_amount: 1 }, notes: { a: 'b' } } }));
    expect(calls[1].body).toEqual(ORDER_BODY(1050, 'INR'));
  });

  it('fails clearly when the shopper has no email, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const shopper of [undefined, {}, { name: 'A', email: '  ' }]) {
      expect(await createIntent(request({ account: shopper, intent: { amount: 1050, currency: 'INR' } }))).toEqual({
        error: 'An email address is required to save the card',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an intent without a positive whole amount', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createIntent(request({ account, intent: { amount: 10.5, currency: 'INR' } }))).toEqual({ error: 'Invalid amount' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an intent without a currency, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createIntent(request({ account, intent: { amount: 1050, currency: '' } }))).toEqual({ error: 'Invalid currency' });
    expect(await createIntent(request({ account, intent: { amount: 1050 } }))).toEqual({ error: 'Invalid currency' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('payment.get_intent', () => {
  const signature = createHmac('sha256', 'secret').update('order_1|pay_1').digest('hex');

  it('returns the verified payment with the token card fields only', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json({
        id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR', email: 'a@b.c', notes: { x: 'y' },
        card: { last4: '1111', network: 'Visa', type: 'credit', issuer: 'X' },
        token: { id: 'token_1', entity: 'token', customer_id: 'cust_1', card: { last4: '1111', network: 'Visa', type: 'credit', issuer: 'X', expiry_month: '12', expiry_year: '2030' } },
      });
    }));
    expect(await getIntent(request({ intent: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: signature } }))).toEqual({
      result: {
        id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR',
        token: { id: 'token_1', card: { last4: '1111', network: 'Visa', expiry_month: '12', expiry_year: '2030' } },
      },
    });
    expect(urls).toEqual(['https://api.razorpay.com/v1/payments/pay_1?expand[]=token']);
  });

  it('returns no token when Razorpay has not created one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR' })));
    const { result } = await getIntent(request({ intent: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: signature } }));
    expect(result.token).toBeUndefined();
  });

  it.each([
    ['a short string', 'forged'],
    ['64 characters that are not hex', 'z'.repeat(64)],
    ['the signature of another payment', createHmac('sha256', 'secret').update('order_1|pay_2').digest('hex')],
    ['the right signature with an extra character', `${signature}0`],
  ])('refuses %s as the signature', async (_name, forged) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await getIntent(request({ intent: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: forged } }))).toEqual({
      error: 'Invalid payment signature',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
