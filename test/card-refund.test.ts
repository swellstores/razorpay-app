import { afterEach, describe, expect, it, vi } from 'vitest';

import refund from '../functions/card-refund';

const request = (data: Record<string, unknown>) => ({ appId: 'razorpay', data, swell: { settings: vi.fn(async () => ({ key_id: 'k', key_secret: 's' })) } }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('payment.refund', () => {
  it('refunds the amount in subunits', async () => {
    const calls: [string, unknown][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return Response.json({ id: 'rfnd_1' });
    }));
    expect(await refund(request({ amount: 5, currency: 'INR', transaction_id: 'pay_1' }))).toEqual({ success: true, transaction_id: 'rfnd_1' });
    expect(calls).toEqual([['https://api.razorpay.com/v1/payments/pay_1/refund', { amount: 500 }]]);
  });

  it('fails without a Razorpay payment, before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await refund(request({ amount: 5, currency: 'INR' }))).toEqual({
      success: false,
      error: { message: 'No Razorpay payment to refund' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -5, undefined, Number.NaN])('fails for the refund amount %s, before calling Razorpay', async (amount) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await refund(request({ amount, currency: 'INR', transaction_id: 'pay_1' }))).toEqual({
      success: false,
      error: { message: 'Refund amount must be greater than zero' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the failure contract on errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"description":"Refund amount too high"}}', { status: 400 })));
    expect(await refund(request({ amount: 5, currency: 'INR', transaction_id: 'pay_1' }))).toEqual({
      success: false,
      error: { message: 'Razorpay: Refund amount too high' },
    });
  });
});
