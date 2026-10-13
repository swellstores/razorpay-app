import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import createIntent from '../functions/card-intent-create';
import getIntent from '../functions/card-intent-get';

const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };
const account = { id: 'acc_1', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+911234567890', billing: { phone: '+910000000001' }, shipping: { phone: '+910000000002' } };

/** The request's account is only its id: the shopper's details come from the loaded `/accounts/acc_1` */
function request(data: Record<string, unknown>, shopper: Record<string, unknown> | undefined = account) {
  const get = vi.fn(async (url: string) => (url === '/accounts/acc_1' ? shopper : null));
  return { appId: 'razorpay', data: { account: { id: 'acc_1' }, ...data }, swell: { settings: vi.fn(async () => settings), get } } as any;
}

afterEach(() => vi.unstubAllGlobals());

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
    const req = request({ intent: { amount: 1050, currency: 'INR' } });
    expect(await createIntent(req)).toEqual({
      result: { order: { id: 'order_1', amount: 1050, currency: 'INR' }, customer: { id: 'cust_1' } },
    });
    expect(req.swell.get).toHaveBeenCalledWith('/accounts/acc_1');
    expect(calls.map((call) => call.url)).toEqual(['https://api.razorpay.com/v1/customers', 'https://api.razorpay.com/v1/orders']);
    expect(calls[0].body).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', contact: '+911234567890', fail_existing: '0' });
    expect(calls[1].body).toEqual(ORDER_BODY(1050, 'INR'));
  });

  it.each([
    ['the billing phone', { name: 'A', email: 'a@b.c', billing: { phone: '+91b' }, shipping: { phone: '+91s' } }, '+91b'],
    ['the shipping phone', { name: 'A', email: 'a@b.c', shipping: { phone: '+91s' } }, '+91s'],
    ['the next phone, trimmed, when one is blank', { name: 'A', email: 'a@b.c', phone: '  ', billing: { phone: ' +91b ' } }, '+91b'],
  ])('falls back to %s as the contact', async (_name, shopper, contact) => {
    const calls = stubRazorpay();
    await createIntent(request({ intent: { amount: 1050, currency: 'INR' } }, shopper));
    expect(calls[0].body.contact).toBe(contact);
  });

  it("reads the phone from the loaded account's billing when the request account has none", async () => {
    const calls = stubRazorpay();
    const shopper = { id: 'acc_1', name: 'A', email: 'a@b.c', billing: { phone: '+91b' } };
    await createIntent(request({ account: { id: 'acc_1', email: 'a@b.c' }, intent: { amount: 1050, currency: 'INR' } }, shopper));
    expect(calls[0].body).toEqual({ name: 'A', email: 'a@b.c', contact: '+91b', fail_existing: '0' });
  });

  it('loads the account by account_id when the request has no account', async () => {
    const calls = stubRazorpay();
    expect(await createIntent(request({ account: undefined, account_id: 'acc_1', intent: { amount: 1050, currency: 'INR' } }))).toHaveProperty('result');
    expect(calls[0].body.contact).toBe('+911234567890');
  });

  it('fails without an account, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const req = request({ account: undefined, intent: { amount: 1050, currency: 'INR' } });
    expect(await createIntent(req)).toEqual({ error: 'No account for this checkout' });
    expect(req.swell.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds the order from the amount and currency only, ignoring other intent fields', async () => {
    const calls = stubRazorpay();
    await createIntent(request({ intent: { amount: 1050, currency: 'inr', customer_id: 'cust_evil', token: { max_amount: 1 }, notes: { a: 'b' } } }));
    expect(calls[1].body).toEqual(ORDER_BODY(1050, 'INR'));
  });

  it('fails clearly when the shopper has no email, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const shopper of [null, {}, { name: 'A', email: '  ' }] as any[]) {
      expect(await createIntent(request({ intent: { amount: 1050, currency: 'INR' } }, shopper))).toEqual({
        error: 'An email address is required to save the card',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails clearly when the shopper has no phone number, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const shopper of [{ name: 'A', email: 'a@b.c' }, { name: 'A', email: 'a@b.c', phone: ' ', billing: {}, shipping: {} }]) {
      expect(await createIntent(request({ intent: { amount: 1050, currency: 'INR' } }, shopper))).toEqual({
        error: 'A phone number is required to save the card',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an intent without a positive whole amount', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createIntent(request({ intent: { amount: 10.5, currency: 'INR' } }))).toEqual({ error: 'Invalid amount' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an intent without a currency, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createIntent(request({ intent: { amount: 1050, currency: '' } }))).toEqual({ error: 'Invalid currency' });
    expect(await createIntent(request({ intent: { amount: 1050 } }))).toEqual({ error: 'Invalid currency' });
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
