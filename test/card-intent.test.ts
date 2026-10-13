import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import createIntent from '../functions/card-intent-create';
import getIntent from '../functions/card-intent-get';

const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };
const request = (data: Record<string, unknown>) => ({ appId: 'razorpay', data, swell: { settings: vi.fn(async () => settings) } }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('payment.create_intent', () => {
  it('creates a Razorpay order with manual capture', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: 'order_1', amount: 1050, currency: 'INR', status: 'created', notes: {} });
    }));
    expect(await createIntent(request({ intent: { amount: 1050, currency: 'INR' } }))).toEqual({
      result: { order: { id: 'order_1', amount: 1050, currency: 'INR' } },
    });
    expect(bodies[0]).toEqual({ amount: 1050, currency: 'INR', payment: { capture: 'manual', capture_options: { manual_expiry_period: 7200, refund_speed: 'normal' } } });
  });

  it('rejects an intent without a positive whole amount', async () => {
    expect(await createIntent(request({ intent: { amount: 10.5, currency: 'INR' } }))).toEqual({ error: 'Invalid amount' });
  });
});

describe('payment.get_intent', () => {
  const signature = createHmac('sha256', 'secret').update('order_1|pay_1').digest('hex');

  it('returns the verified payment without provider internals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR', email: 'a@b.c', card: { last4: '1111', network: 'Visa', type: 'credit', issuer: 'X' },
    })));
    expect(await getIntent(request({ intent: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: signature } }))).toEqual({
      result: { id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR', card: { last4: '1111', network: 'Visa', type: 'credit' } },
    });
  });

  it('refuses a wrong signature', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await getIntent(request({ intent: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' } }))).toEqual({
      error: 'Invalid payment signature',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
