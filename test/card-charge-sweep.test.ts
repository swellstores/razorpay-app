import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import sweep from '../functions/card-charge-sweep';
import { fakeRazorpay, settings, summary } from './fake-razorpay';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const MINUTE = 60 * 1000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

/** A sweep request whose Swell lists `pending` as the payments left pending */
function request(pending: Record<string, unknown>[]) {
  const get = vi.fn(async (url: string) => (url === '/payments' ? { count: pending.length, results: pending } : null));
  return { appId: 'razorpay', data: {}, swell: { settings: vi.fn(async () => settings), get, put: vi.fn(async () => ({})) } } as any;
}

const writesOf = (req: any): [string, unknown][] => req.swell.put.mock.calls;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Silences and returns the console.error spy */
const quietLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

// A Swell payment the charge left pending, its Razorpay order (created_at in seconds) and payment
const pending = { id: 'swell_pay_1', amount: 10.5, currency: 'INR', method: 'card', async: true, date_created: ago(10) };
const order = { id: 'order_1', amount: 1050, currency: 'INR', receipt: 'swell_pay_1', created_at: (NOW - 10 * MINUTE) / 1000 };
const saved = { id: 'pay_saved', status: 'authorized', amount: 1050, currency: 'INR', method: 'card', order_id: 'order_1', notes: [] };

const LOOKUP = ['GET /orders?receipt=swell_pay_1&count=100', 'GET /orders/order_1/payments'];
const finished = (transactionId: string, captured = true) => [
  ['/payments/swell_pay_1', { transaction_id: transactionId, success: true, ...(captured && { captured: true }) }],
];
const failed = (message: string) => [['/payments/swell_pay_1', { success: false, error: { message } }]];

describe('saved card charge sweep', () => {
  it('lists the oldest pending card payments of the last 8 days, but not the last 2 minutes', async () => {
    fakeRazorpay([]);
    const req = request([]);
    await sweep(req);
    expect(req.swell.get).toHaveBeenCalledWith('/payments', {
      where: {
        async: true,
        success: null,
        method: 'card',
        void: { $ne: true },
        date_created: { $lt: ago(2), $gt: ago(8 * 24 * 60) },
      },
      sort: 'date_created asc',
      limit: 50,
    });
  });

  it('does nothing without pending payments, not even reading the settings', async () => {
    const { calls } = fakeRazorpay([]);
    const req = request([]);
    await sweep(req);
    expect(calls).toEqual([]);
    expect(req.swell.settings).not.toHaveBeenCalled();
    expect(writesOf(req)).toEqual([]);
  });

  describe('captured payment', () => {
    it('finishes the Swell payment as captured', async () => {
      const { calls } = fakeRazorpay([{ ...saved, status: 'captured' }], { orders: [order] });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(LOOKUP);
    });

    it('finishes it without capturing when the Swell payment is authorize only', async () => {
      fakeRazorpay([{ ...saved, status: 'captured' }], { orders: [order] });
      const req = request([{ ...pending, captured: false }]);
      await sweep(req);
      expect(writesOf(req)).toEqual(finished('pay_saved', false));
    });

    it('fails the Swell payment, naming the Razorpay payment, when it does not match the order', async () => {
      quietLog();
      const { calls } = fakeRazorpay([{ ...saved, status: 'captured', amount: 999 }], { orders: [order] });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual(
        failed('Saved card payment pay_saved was not finalized: Payment amount 999 INR does not match the order amount 1050 INR'),
      );
      expect(summary(calls)).toEqual(LOOKUP);
    });
  });

  describe('authorized payment', () => {
    it('captures it, then finishes the Swell payment as captured', async () => {
      const { calls, payment } = fakeRazorpay([saved], { orders: [order] });
      const req = request([pending]);
      await sweep(req);
      expect(summary(calls)).toEqual([...LOOKUP, 'POST /payments/pay_saved/capture']);
      expect(calls.at(-1)?.body).toEqual({ amount: 1050, currency: 'INR' });
      expect(payment('pay_saved')).toMatchObject({ status: 'captured' });
      expect(writesOf(req)).toEqual(finished('pay_saved'));
    });

    it('records the transaction without capturing when the Swell payment is authorize only', async () => {
      const { calls } = fakeRazorpay([saved], { orders: [order] });
      const req = request([{ ...pending, captured: false }]);
      await sweep(req);
      expect(summary(calls)).toEqual(LOOKUP);
      expect(writesOf(req)).toEqual(finished('pay_saved', false));
    });

    it('fails the Swell payment, naming the Razorpay payment, when Razorpay refuses the capture', async () => {
      quietLog();
      fakeRazorpay([saved], { orders: [order], captures: { pay_saved: 'refused' } });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Razorpay: Capture amount is invalid'));
    });

    it('leaves the Swell payment pending when the capture outcome is unknown', async () => {
      const log = quietLog();
      fakeRazorpay([saved], { orders: [order], captures: { pay_saved: 'error' } });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('swell_pay_1'));
    });
  });

  it('leaves the Swell payment pending while Razorpay waits to debit the card (live pre-debit)', async () => {
    const { calls } = fakeRazorpay([{ ...saved, status: 'created' }], { orders: [order] });
    const req = request([{ ...pending, date_created: ago(3 * 24 * 60) }]);
    await sweep(req);
    expect(writesOf(req)).toEqual([]);
    expect(summary(calls)).toEqual(LOOKUP);
  });

  describe('order without a Razorpay payment', () => {
    it.each([
      ['no payment at all', []],
      ['only a failed payment', [{ ...saved, status: 'failed' }]],
    ])('fails the Swell payment after 30 minutes with %s', async (_name, payments) => {
      quietLog();
      const old = { ...order, created_at: (NOW - 31 * MINUTE) / 1000 };
      fakeRazorpay(payments, { orders: [old] });
      const req = request([{ ...pending, date_created: ago(31) }]);
      await sweep(req);
      expect(writesOf(req)).toEqual(failed('The saved card charge did not complete'));
    });

    it('leaves it pending before 30 minutes', async () => {
      fakeRazorpay([], { orders: [order] });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual([]);
    });

    it('counts the 30 minutes from the Swell payment when the order has no creation time', async () => {
      const { created_at: _createdAt, ...untimed } = order;
      fakeRazorpay([], { orders: [untimed] });
      const req = request([pending]);
      await sweep(req);
      expect(writesOf(req)).toEqual([]);
    });

    it('counts the 30 minutes from the newest order, so an old Swell payment charged again just now is left pending', async () => {
      fakeRazorpay([], { orders: [order] });
      const req = request([{ ...pending, date_created: ago(5 * 24 * 60) }]);
      await sweep(req);
      expect(writesOf(req)).toEqual([]);
    });
  });

  it('leaves a Swell payment without a Razorpay order of its receipt alone: it is not this app\'s charge', async () => {
    const { calls } = fakeRazorpay([], { orders: [{ ...order, receipt: 'swell_pay_other' }] });
    const req = request([{ ...pending, date_created: ago(3 * 24 * 60) }]);
    await sweep(req);
    expect(writesOf(req)).toEqual([]);
    expect(summary(calls)).toEqual([LOOKUP[0]]);
  });

  it('leaves the Swell payment pending when the lookup fails', async () => {
    const log = quietLog();
    fakeRazorpay([saved], { orders: [order], failLookup: 'payments' });
    const req = request([pending]);
    await sweep(req);
    expect(writesOf(req)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Service unavailable'), expect.stringContaining('swell_pay_1'));
  });

  it('sweeps every payment when one of them fails', async () => {
    const log = quietLog();
    const second = { ...saved, id: 'pay_second', order_id: 'order_2', status: 'captured' };
    fakeRazorpay([saved, second], { orders: [order, { ...order, id: 'order_2', receipt: 'swell_pay_2' }] });
    const req = request([{ ...pending, amount: undefined }, { ...pending, id: 'swell_pay_2' }]);
    await sweep(req);
    expect(writesOf(req)).toEqual([['/payments/swell_pay_2', { transaction_id: 'pay_second', success: true, captured: true }]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid amount'), expect.stringContaining('swell_pay_1'));
  });
});
