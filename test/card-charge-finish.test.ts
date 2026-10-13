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
/** The engine stopped the run at a sleep; it runs it again later, replaying the steps it recorded */
class Evicted extends Error {}

type Recorded = { result: unknown } | { error: string };

/**
 * A fake step runner, as the platform runs steps. A step is keyed by its name plus a per-name counter, so
 * the same name twice in a run is two steps. A step runs its function and records a JSON copy of the
 * result; it retries a failure up to its `retries.limit` (5 by default), then fails with the message only
 * (the error's class and status do not survive), and records that too. A step already in `cache` (from an
 * earlier run of the same instance) is not run again: it returns or throws what was recorded. A sleep is
 * recorded the same way; `evictAt` stops the run at that sleep, as the engine does when it unloads a
 * sleeping run. `onSleep` and `afterStep` let a test change the world in between.
 */
function fakeStep(
  options:
    | ((name: string) => void)
    | {
        onSleep?: (name: string) => void;
        afterStep?: (name: string) => void;
        cache?: Map<string, Recorded>;
        evictAt?: string;
      } = {},
) {
  const { onSleep = () => undefined, afterStep = () => undefined, cache = new Map<string, Recorded>(), evictAt } =
    typeof options === 'function' ? { onSleep: options } : options;
  const log: string[] = [];
  const counts = new Map<string, number>();
  const keyOf = (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return `${name}#${count}`;
  };
  const step = {
    async do(name: string, stepOptions: any, fn?: () => Promise<unknown>) {
      if (typeof stepOptions === 'function') [fn, stepOptions] = [stepOptions, {}];
      const key = keyOf(name);
      const recorded = cache.get(key);
      if (recorded) {
        if ('error' in recorded) throw new Error(recorded.error);
        return recorded.result;
      }
      const limit = stepOptions.retries?.limit ?? DEFAULT_RETRIES;
      for (let attempt = 0; ; attempt++) {
        log.push(name);
        try {
          const value = await fn!();
          const result = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
          cache.set(key, { result });
          afterStep(name);
          return result;
        } catch (error) {
          if (attempt >= limit) {
            const message = error instanceof Error ? error.message : String(error);
            cache.set(key, { error: message });
            throw new Error(message);
          }
        }
      }
    },
    async sleep(name: string, duration: string) {
      const key = keyOf(name);
      if (cache.has(key)) return;
      log.push(`sleep ${name} (${duration})`);
      cache.set(key, { result: null });
      onSleep(name);
      if (name === evictAt) throw new Evicted(name);
    },
    async sleepUntil() {
      throw new Error('not used');
    },
  };
  return { step: step as any, log, cache };
}

const run = (req: unknown, step: unknown) => new CardChargeFinish().run(req as any, step as any);
const writesOf = (req: any): [string, unknown][] => req.swell.put.mock.calls;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Silences and returns the console.error spy */
const quietLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const ON_ORDER = 'GET /orders/order_9/payments';
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
    expect(log).toEqual(['check pending', 'charge saved card', 'capture', 'record']);
    expect(summary(calls)).toEqual([ON_ORDER, RECURRING, CAPTURE]);
    expect(calls.find((call) => call.url.endsWith('/create/recurring'))?.body).toEqual({
      email: 'ada@example.com', contact: '+911234567890', amount: 1050, currency: 'INR',
      order_id: 'order_9', customer_id: 'cust_1', token: 'token_1', recurring: '1', notes: { swell_payment_id: 'swell_pay_1' },
    });
    expect(calls.find((call) => call.url.endsWith('/capture'))?.body).toEqual({ amount: 1050, currency: 'INR' });
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
      expect(log).toEqual(['check pending', 'charge saved card', 'capture', 'record', 'late capture']);
      expect(summary(calls)).toEqual([ON_ORDER, RECURRING]);
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
      expect(summary(calls)).toEqual([ON_ORDER, RECURRING, CAPTURE]);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured' });
      expect(writesOf(req)).toEqual([...finished(false), ['/payments/swell_pay_1', { captured: true }]]);
    });
  });

  it('reads the payment when Razorpay answers without a valid signature, and goes on when it is authorized', async () => {
    const { calls } = fakeRazorpay([], { orders: [order], recurringSignature: false });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['check pending', 'charge saved card', 'read payment', 'capture', 'record']);
    expect(summary(calls)).toEqual([ON_ORDER, RECURRING, READ, CAPTURE]);
    expect(writesOf(req)).toEqual(finished());
  });

  describe('payment waiting for the live debit (created)', () => {
    it('reads it again every 6 hours until it is authorized', async () => {
      const razorpay = fakeRazorpay([], { orders: [order], recurringStatus: 'created' });
      const { req } = request();
      const { step, log } = fakeStep((name) => name === 'wait for debit 2' && razorpay.update('pay_saved', { status: 'authorized' }));
      await run(req, step);
      expect(log).toEqual([
        'check pending',
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
    expect(log).toEqual(['check pending', 'charge saved card', 'read payment', 'record']);
    expect(summary(calls)).toEqual([ON_ORDER, RECURRING, READ]);
    expect(writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
  });

  it('fails the Swell payment, without waiting, when Razorpay refuses the payment', async () => {
    quietLog();
    const { calls } = fakeRazorpay([], { orders: [order], refuseRecurring: true });
    const { req } = request();
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['check pending', 'charge saved card', 'record']);
    expect(summary(calls)).toEqual([ON_ORDER, RECURRING, ON_ORDER]);
    expect(writesOf(req)).toEqual(failed('Razorpay: The token is invalid'));
  });

  describe('create/recurring with an unknown outcome', () => {
    it('never creates it again, waits, and finishes the payment it finds by the order receipt', async () => {
      const { calls } = fakeRazorpay([], { orders: [order], loseRecurring: true });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['check pending', 'charge saved card', 'sleep wait for Razorpay (1 minute)', 'find by receipt', 'capture', 'record']);
      expect(summary(calls)).toEqual([ON_ORDER, RECURRING, 'GET /orders?receipt=swell_pay_1&count=100', 'GET /orders/order_9/payments', CAPTURE]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('fails the Swell payment when no payment is found by the order receipt', async () => {
      quietLog();
      const { calls } = fakeRazorpay([], { orders: [order], recurringDown: true });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['check pending', 'charge saved card', 'sleep wait for Razorpay (1 minute)', 'find by receipt', 'record']);
      expect(summary(calls).filter((call) => call === RECURRING)).toHaveLength(1);
      expect(writesOf(req)).toEqual(failed('The saved card charge did not complete'));
    });

    it('waits for the debit of a payment it finds still created', async () => {
      const razorpay = fakeRazorpay([], { orders: [order], loseRecurring: true, recurringStatus: 'created' });
      const { req } = request();
      const { step, log } = fakeStep((name) => name === 'wait for debit 1' && razorpay.update('pay_saved', { status: 'authorized' }));
      await run(req, step);
      expect(log).toEqual([
        'check pending',
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

  it('charges nothing for a Swell payment that already has its result (the sweep failed it before the run started)', async () => {
    const { calls } = fakeRazorpay([], { orders: [order] });
    const { req } = request({ captured: true, success: false });
    const { step, log } = fakeStep();
    await run(req, step);
    expect(log).toEqual(['check pending']);
    expect(calls).toEqual([]);
    expect(writesOf(req)).toEqual([]);
  });

  it('does not write over a Swell payment the sweep finished meanwhile', async () => {
    fakeRazorpay([], { orders: [order] });
    const log = quietLog();
    const { req, stored } = request();
    const engine = fakeStep({ afterStep: (name) => name === 'capture' && Object.assign(stored, { success: true, transaction_id: 'pay_saved' }) });
    await run(req, engine.step);
    expect(engine.log).toEqual(['check pending', 'charge saved card', 'capture', 'record']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already has a result'), expect.stringMatching(/swell_pay_1.*pay_saved/));
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
    expect(summary(calls)).toEqual([ON_ORDER, RECURRING, CAPTURE, READ]);
    expect(writesOf(req)).toEqual(finished());
  });

  describe('at most one payment per order (a step may run again after an engine restart)', () => {
    const existing = { id: 'pay_saved', status: 'authorized', amount: 1050, currency: 'INR', method: 'card', order_id: 'order_9' };

    it('reuses a payment already on the order instead of creating another', async () => {
      const { calls } = fakeRazorpay([existing], { orders: [order] });
      const { req } = request();
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['check pending', 'charge saved card', 'capture', 'record']);
      expect(summary(calls)).toEqual([ON_ORDER, CAPTURE]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('waits for the debit of a payment already on the order that is still created', async () => {
      const razorpay = fakeRazorpay([{ ...existing, status: 'created' }], { orders: [order] });
      const { req } = request();
      const { step, log } = fakeStep((name) => razorpay.update('pay_saved', { status: 'authorized' }) && name);
      await run(req, step);
      expect(log.slice(0, 4)).toEqual(['check pending', 'charge saved card', 'sleep wait for debit 1 (6 hours)', 'read payment']);
      expect(summary(razorpay.calls)).not.toContain(RECURRING);
      expect(writesOf(req)).toEqual(finished());
    });

    it('does not take a 4xx for a refusal when the order has a payment that holds the money', async () => {
      const razorpay = fakeRazorpay([], { orders: [order], refuseRecurring: true });
      const fetch = globalThis.fetch;
      // The first attempt's payment shows up on the order while the repeated create/recurring is refused
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (url.endsWith('/payments/create/recurring')) razorpay.update('pay_saved', existing);
        return fetch(url, init);
      });
      const { req } = request();
      await run(req, fakeStep().step);
      expect(summary(razorpay.calls)).toEqual([ON_ORDER, RECURRING, ON_ORDER, CAPTURE]);
      expect(writesOf(req)).toEqual(finished());
    });
  });

  describe('a Swell payment failed or voided while the run waited', () => {
    it.each([
      ['failed', { success: false }],
      ['voided', { void: true }],
    ])('does not capture a payment whose Swell payment was %s, and logs it', async (_name, change) => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { orders: [order] });
      const { req, stored } = request();
      const { step, log: steps } = fakeStep({ afterStep: (name) => name === 'charge saved card' && Object.assign(stored, change) });
      await run(req, step);
      expect(steps).toEqual(['check pending', 'charge saved card', 'capture']);
      expect(summary(calls)).toEqual([ON_ORDER, RECURRING]);
      expect(writesOf(req)).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/swell_pay_1.*pay_saved/));
    });

    it('charges nothing for a voided Swell payment, without reading the keys', async () => {
      const { calls } = fakeRazorpay([], { orders: [order] });
      const { req } = request({ captured: true, void: true });
      const { step, log } = fakeStep();
      await run(req, step);
      expect(log).toEqual(['check pending']);
      expect(calls).toEqual([]);
      expect(req.swell.get).not.toHaveBeenCalledWith('/settings/razorpay/card');
    });
  });

  describe('a capture asked for after the capture step', () => {
    it('captures in the record step before writing the success', async () => {
      const { calls } = fakeRazorpay([], { orders: [order] });
      const { req, stored } = request({ captured: false });
      const { step, log } = fakeStep({ afterStep: (name) => name === 'capture' && (stored.captured = true) });
      await run(req, step);
      expect(log).toEqual(['check pending', 'charge saved card', 'capture', 'record']);
      expect(summary(calls)).toEqual([ON_ORDER, RECURRING, CAPTURE]);
      expect(writesOf(req)).toEqual(finished());
    });

    it('retries a late capture 6 times, then logs it once and ends the run', async () => {
      const log = quietLog();
      fakeRazorpay([], { orders: [order], captures: { pay_saved: 'error' } });
      const { req, stored } = request({ captured: false });
      const { step, log: steps } = fakeStep({ afterStep: (name) => name === 'record' && (stored.captured = true) });
      await expect(run(req, step)).resolves.toBe(true);
      expect(steps.filter((name) => name === 'late capture')).toHaveLength(7);
      expect(writesOf(req)).toEqual(finished(false));
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('late capture'), expect.stringMatching(/swell_pay_1.*pay_saved/));
    });
  });

  it('never keeps the Razorpay keys in a step result', async () => {
    fakeRazorpay([], { orders: [order], recurringSignature: false });
    const { req } = request({ captured: false });
    const { step, cache } = fakeStep();
    await run(req, step);
    const recorded = JSON.stringify([...cache.entries()]);
    expect(recorded).not.toContain(settings.key_secret);
    expect(recorded).not.toContain(settings.key_id);
  });

  it('creates the payment once when the engine replays the run after a sleep', async () => {
    const razorpay = fakeRazorpay([], { orders: [order], recurringStatus: 'created' });
    const { req } = request();
    const first = fakeStep({ evictAt: 'wait for debit 1' });
    await expect(run(req, first.step)).rejects.toThrow(Evicted);
    razorpay.update('pay_saved', { status: 'authorized' });
    const replay = fakeStep({ cache: first.cache });
    await run(req, replay.step);
    expect(replay.log).toEqual(['read payment 2', 'capture', 'record']);
    expect(summary(razorpay.calls).filter((call) => call === RECURRING)).toHaveLength(1);
    expect(writesOf(req)).toEqual(finished());
  });
});
