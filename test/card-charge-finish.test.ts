import { afterEach, describe, expect, it, vi } from 'vitest';

import CardChargeFinish, { config } from '../functions/card-charge-finish';
import { fakeRazorpay, settings, summary } from './fake-razorpay';

const customer = { id: 'cust_1', email: 'ada@example.com', contact: '+911234567890' };
const params = { swell_payment_id: 'swell_pay_1', razorpay_order_id: 'order_9', amount: 1050, currency: 'INR', token: 'token_1', customer };
// The hook created the order with the Swell payment id as the receipt
const order = { id: 'order_9', amount: 1050, currency: 'INR', receipt: 'swell_pay_1' };

/**
 * A workflow request: `record` is the Swell payment as stored, which reads back as stored and a write
 * updates (a test may change it on the way). `answer` replaces the write's answer.
 */
function request(record: Record<string, unknown> = { captured: true }) {
  const stored: Record<string, unknown> = { id: 'swell_pay_1', async: true, ...record };
  const get = vi.fn(async (path: string) => {
    if (path === '/settings/razorpay/card') return settings;
    if (path === '/payments/swell_pay_1') return { ...stored };
    return null;
  });
  const put = vi.fn(async (path: string, data: Record<string, unknown>) => {
    if (path !== '/payments/swell_pay_1') return null;
    Object.assign(stored, data);
    return { ...stored };
  });
  const req = {
    id: 'req_1',
    appId: 'razorpay',
    store: { id: 'store_1' },
    data: params,
    workflow: { workflow_id: 'wf_1', workflow_name: 'card-charge-finish', workflow_instance_id: 'wf_inst_1', trigger: 'function', request_id: 'r1' },
    isLocalDev: false,
    swell: { get, put, post: vi.fn(), delete: vi.fn(), settings: vi.fn(async () => settings) },
  };
  return { req, stored };
}

const DEFAULT_RETRIES = 5;

/**
 * A fake step runner, as the platform runs steps: a step runs its function and keeps a JSON copy of the
 * result; it retries a failure up to its `retries.limit` (5 by default), then fails with the message only
 * (the error's class and status do not survive). Step names must be unique, since a repeated name would
 * return the first result. `sleep` records and calls `onSleep`.
 */
function fakeStep(onSleep: (name: string) => void = () => undefined) {
  const log: string[] = [];
  const names = new Set<string>();
  const step = {
    async do(name: string, options: any, fn?: () => Promise<unknown>) {
      if (typeof options === 'function') [fn, options] = [options, {}];
      if (names.has(name)) throw new Error(`Step name used twice: ${name}`);
      names.add(name);
      const limit = options.retries?.limit ?? DEFAULT_RETRIES;
      for (let attempt = 0; ; attempt++) {
        log.push(name);
        try {
          const result = await fn!();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        } catch (error) {
          if (attempt >= limit) throw new Error(error instanceof Error ? error.message : String(error));
        }
      }
    },
    async sleep(name: string, duration: string) {
      if (names.has(name)) throw new Error(`Step name used twice: ${name}`);
      names.add(name);
      log.push(`sleep ${name} (${duration})`);
      onSleep(name);
    },
    async sleepUntil() {
      throw new Error('not used');
    },
  };
  return { step: step as any, log };
}

const run = (req: unknown, step: unknown) => new CardChargeFinish().run(req as any, step as any);
const writesOf = (req: any): [string, unknown][] => req.swell.put.mock.calls;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Silences and returns the console.error spy */
const quietLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const RECURRING = 'POST /payments/create/recurring';
const CAPTURE = 'POST /payments/pay_saved/capture';
const READ = 'GET /payments/pay_saved';
const finished = (captured = true) => [
  ['/payments/swell_pay_1', { transaction_id: 'pay_saved', success: true, ...(captured && { captured: true }) }],
];
const failed = (message: string) => [['/payments/swell_pay_1', { success: false, error: { message } }]];

describe('card-charge-finish workflow', () => {
  it('is a workflow', () => {
    expect(config).toEqual({ kind: 'workflow', description: expect.any(String) });
  });

  it('charges the saved card, captures it and records it when Razorpay signs the payment', async () => {
    const { calls, payment } = fakeRazorpay([], { orders: [order] });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['charge saved card', 'capture', 'record']);
    expect(summary(calls)).toEqual([RECURRING, CAPTURE]);
    expect(calls[0].body).toEqual({
      email: 'ada@example.com', contact: '+911234567890', amount: 1050, currency: 'INR',
      order_id: 'order_9', customer_id: 'cust_1', token: 'token_1', recurring: '1', notes: { swell_payment_id: 'swell_pay_1' },
    });
    expect(calls[1].body).toEqual({ amount: 1050, currency: 'INR' });
    expect(payment('pay_saved')).toMatchObject({ status: 'captured' });
    expect(writesOf(req)).toEqual(finished());
  });

  it('reads the settings of the app, not params, for the keys', async () => {
    fakeRazorpay([], { orders: [order] });
    const { req } = request();
    await run(req, fakeStep().step);
    expect(req.swell.get).toHaveBeenCalledWith('/settings/razorpay/card');
  });

  describe('authorize only (the Swell payment is captured: false)', () => {
    it('records the authorization without capturing', async () => {
      const { calls, payment } = fakeRazorpay([], { orders: [order] });
      const { req } = request({ captured: false });
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['charge saved card', 'capture', 'record', 'late capture']);
      expect(summary(calls)).toEqual([RECURRING]);
      expect(payment('pay_saved')).toMatchObject({ status: 'authorized' });
      expect(writesOf(req)).toEqual(finished(false));
    });

    it('captures late when the Swell payment was captured meanwhile', async () => {
      const { calls, payment } = fakeRazorpay([], { orders: [order] });
      const { req, stored } = request({ captured: false });
      const write = req.swell.put.getMockImplementation()!;
      req.swell.put.mockImplementation(async (path: string, data: Record<string, unknown>) => {
        const result = await write(path, data);
        if (data.success) stored.captured = true;
        return result;
      });
      await run(req, fakeStep().step);
      expect(summary(calls)).toEqual([RECURRING, CAPTURE]);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured' });
      expect(writesOf(req)).toEqual([...finished(false), ['/payments/swell_pay_1', { captured: true }]]);
    });
  });

  it('reads the payment when Razorpay answers without a valid signature, and goes on when it is authorized', async () => {
    const { calls } = fakeRazorpay([], { orders: [order], recurringSignature: false });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['charge saved card', 'read payment', 'capture', 'record']);
    expect(summary(calls)).toEqual([RECURRING, READ, CAPTURE]);
    expect(writesOf(req)).toEqual(finished());
  });

  describe('payment waiting for the live debit (created)', () => {
    it('reads it again every 6 hours until it is authorized', async () => {
      const razorpay = fakeRazorpay([], { orders: [order], recurringStatus: 'created' });
      const { req } = request();
      const { step, log } = fakeStep((name) => name === 'wait for debit 2' && razorpay.update('pay_saved', { status: 'authorized' }));
      await run(req, step);
      expect(log).toEqual([
        'charge saved card',
        'read payment',
        'sleep wait for debit 1 (6 hours)',
        'read payment 2',
        'sleep wait for debit 2 (6 hours)',
        'read payment 3',
        'capture',
        'record',
      ]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('fails the Swell payment, naming the Razorpay payment, after 8 days', async () => {
      quietLog();
      fakeRazorpay([], { orders: [order], recurringStatus: 'created' });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log.filter((entry) => entry.startsWith('sleep'))).toHaveLength(32);
      expect(log.at(-1)).toBe('record');
      expect(writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Payment is still pending (status: created) after 8 days'));
    });
  });

  it('fails the Swell payment, naming the Razorpay payment, when it is neither authorized nor captured', async () => {
    quietLog();
    const { calls } = fakeRazorpay([], { orders: [order], recurringStatus: 'failed' });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['charge saved card', 'read payment', 'record']);
    expect(summary(calls)).toEqual([RECURRING, READ]);
    expect(writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
  });

  it('fails the Swell payment, without waiting, when Razorpay refuses the payment', async () => {
    quietLog();
    const { calls } = fakeRazorpay([], { orders: [order], refuseRecurring: true });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['charge saved card', 'record']);
    expect(summary(calls)).toEqual([RECURRING]);
    expect(writesOf(req)).toEqual(failed('Razorpay: The token is invalid'));
  });

  describe('create/recurring with an unknown outcome', () => {
    it('never creates it again, waits, and finishes the payment it finds by the order receipt', async () => {
      const { calls } = fakeRazorpay([], { orders: [order], loseRecurring: true });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['charge saved card', 'sleep wait for Razorpay (1 minute)', 'find by receipt', 'capture', 'record']);
      expect(summary(calls)).toEqual([RECURRING, 'GET /orders?receipt=swell_pay_1&count=100', 'GET /orders/order_9/payments', CAPTURE]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('fails the Swell payment when no payment is found by the order receipt', async () => {
      quietLog();
      const { calls } = fakeRazorpay([], { orders: [order], recurringDown: true });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['charge saved card', 'sleep wait for Razorpay (1 minute)', 'find by receipt', 'record']);
      expect(summary(calls).filter((call) => call === RECURRING)).toHaveLength(1);
      expect(writesOf(req)).toEqual(failed('The saved card charge did not complete'));
    });

    it('waits for the debit of a payment it finds still created', async () => {
      const razorpay = fakeRazorpay([], { orders: [order], loseRecurring: true, recurringStatus: 'created' });
      const { req } = request();
      const { step, log } = fakeStep((name) => name === 'wait for debit 1' && razorpay.update('pay_saved', { status: 'authorized' }));
      await run(req, step);
      expect(log).toEqual([
        'charge saved card',
        'sleep wait for Razorpay (1 minute)',
        'find by receipt',
        'sleep wait for debit 1 (6 hours)',
        'read payment',
        'capture',
        'record',
      ]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('fails the Swell payment, naming the payment, when the one it finds was captured for another amount', async () => {
      quietLog();
      fakeRazorpay([{ id: 'pay_other', status: 'captured', amount: 999, currency: 'INR', method: 'card', order_id: 'order_9' }], {
        orders: [order], recurringDown: true,
      });
      const { req } = request();
      await run(req, fakeStep().step);
      expect(writesOf(req)).toEqual(
        failed('Saved card payment pay_other was not finalized: Payment amount 999 INR does not match the order amount 1050 INR'),
      );
    });
  });

  it('retries a record that Swell refuses, then fails the run', async () => {
    fakeRazorpay([], { orders: [order] });
    const { req } = request();
    req.swell.put.mockResolvedValue({ errors: { success: { code: 'INVALID', message: 'Invalid' } } });
    const { step, log } = fakeStep();
    await expect(run(req, step)).rejects.toThrow('Could not record the saved card charge');
    expect(log.filter((name) => name === 'record')).toHaveLength(4);
  });

  it('retries a record that Swell answers without the payment', async () => {
    fakeRazorpay([], { orders: [order] });
    const { req } = request();
    req.swell.put.mockResolvedValue(null);
    await expect(run(req, fakeStep().step)).rejects.toThrow('Swell answered without the payment');
    expect(req.swell.put).toHaveBeenCalledTimes(4);
  });

  it('does not write over a Swell payment the sweep finished meanwhile', async () => {
    fakeRazorpay([], { orders: [order] });
    const { req } = request({ captured: true, success: true, transaction_id: 'pay_saved' });
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['charge saved card', 'capture', 'record']);
    expect(writesOf(req)).toEqual([]);
  });

  it('fails the run, leaving the Swell payment to the sweep, when the capture keeps failing', async () => {
    fakeRazorpay([], { orders: [order], captures: { pay_saved: 'error' } });
    const { req } = request();
    const { step, log } = fakeStep();
    await expect(run(req, step)).rejects.toThrow('Gateway timeout');
    expect(log.filter((name) => name === 'capture')).toHaveLength(4);
    expect(writesOf(req)).toEqual([]);
  });

  it('succeeds on a capture retry after a capture whose answer was lost', async () => {
    const { calls } = fakeRazorpay([], { orders: [order], captures: { pay_saved: 'lost' } });
    const { req } = request();
    await run(req, fakeStep().step);
    expect(summary(calls)).toEqual([RECURRING, CAPTURE, READ]);
    expect(writesOf(req)).toEqual(finished());
  });
});
