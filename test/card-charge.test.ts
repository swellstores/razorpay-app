import { afterEach, describe, expect, it, vi } from 'vitest';

import charge from '../functions/card-charge';

const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };

function request(data: Record<string, unknown>) {
  return { appId: 'razorpay', data, swell: { settings: vi.fn(async () => settings) } } as any;
}

function mockRazorpay(payment: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/capture')) return Response.json({ ...payment, status: 'captured' });
    return Response.json(payment);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const base = { amount: 10.5, currency: 'INR', intent: { razorpay: { id: 'pay_1' } } };

describe('payment.charge', () => {
  it('accepts an authorized payment of the order amount in the authorize phase', async () => {
    const calls = mockRazorpay({ id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR' });
    expect(await charge(request({ ...base, captured: false }))).toEqual({ success: true, transaction_id: 'pay_1' });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('fails the authorize phase when the amount differs', async () => {
    mockRazorpay({ id: 'pay_1', status: 'authorized', amount: 999, currency: 'INR' });
    expect(await charge(request({ ...base, captured: false }))).toEqual({
      success: false,
      error: { message: 'Authorized amount 999 INR does not match the order amount 1050 INR' },
    });
  });

  it('fails the authorize phase when the payment is not authorized', async () => {
    mockRazorpay({ id: 'pay_1', status: 'failed', amount: 1050, currency: 'INR' });
    expect(await charge(request({ ...base, captured: false }))).toEqual({
      success: false,
      error: { message: 'Payment is not authorized (status: failed)' },
    });
  });

  it('captures an authorized payment in the capture phase', async () => {
    const calls = mockRazorpay({ id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR' });
    expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
    expect(calls[1]).toEqual({ url: 'https://api.razorpay.com/v1/payments/pay_1/capture', method: 'POST', body: { amount: 1050, currency: 'INR' } });
  });

  it('treats a missing captured flag as a capture request', async () => {
    const calls = mockRazorpay({ id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR' });
    await charge(request(base));
    expect(calls.at(-1)?.url).toBe('https://api.razorpay.com/v1/payments/pay_1/capture');
  });

  it('succeeds without a second capture when already captured', async () => {
    const calls = mockRazorpay({ id: 'pay_1', status: 'captured', amount: 1050, currency: 'INR' });
    expect(await charge(request({ ...base, captured: true }))).toEqual({ success: true, transaction_id: 'pay_1' });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('uses the transaction id when the intent is gone', async () => {
    const calls = mockRazorpay({ id: 'pay_2', status: 'captured', amount: 1050, currency: 'INR' });
    await charge(request({ amount: 10.5, currency: 'INR', captured: true, transaction_id: 'pay_2' }));
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_2');
  });

  it('fails without a Razorpay payment', async () => {
    expect(await charge(request({ amount: 1, currency: 'INR', captured: false }))).toEqual({
      success: false,
      error: { message: 'No Razorpay payment for this charge' },
    });
  });

  it('turns Razorpay API errors into the failure contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"description":"Bad request"}}', { status: 400 })));
    expect(await charge(request({ ...base, captured: true }))).toEqual({
      success: false,
      error: { message: 'Razorpay: Bad request' },
    });
  });
});
