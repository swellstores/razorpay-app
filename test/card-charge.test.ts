import { afterEach, describe, expect, it, vi } from 'vitest';

import charge from '../functions/card-charge';
import { API, type Call, fakeRazorpay, settings, summary } from './fake-razorpay';

const account = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+911234567890', billing: { phone: '+910000000001' }, shipping: { phone: '+910000000002' } };

// Every test's background work, settled before the fake Razorpay goes away
const backgrounds: Promise<unknown>[] = [];

/** A charge request; `waitUntil` collects the background work, which `writesOf` awaits */
function request(data: Record<string, unknown>, shopper: Record<string, unknown> | undefined = account) {
  const get = vi.fn(async (url: string) => (url === '/accounts/acc_1' ? shopper : null));
  const background: Promise<unknown>[] = [];
  return {
    appId: 'razorpay',
    data,
    background,
    context: { waitUntil: (promise: Promise<unknown>) => background.push(promise) && backgrounds.push(promise) },
    appValues: (values: object) => ({ $app: { razorpay: values } }),
    swell: { settings: vi.fn(async () => settings), get, put: vi.fn(async () => ({})) },
  } as any;
}

/** The writes to the Swell payment, once the charge's background work settled */
async function writesOf(req: any): Promise<[string, unknown][]> {
  await Promise.all(req.background);
  return req.swell.put.mock.calls.filter(([url]: [string]) => url.startsWith('/payments/'));
}

afterEach(async () => {
  await Promise.allSettled(backgrounds.splice(0));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Silences and returns the console.error spy */
const quietLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const card = { token: 'token_1', last4: '1111', brand: 'Visa', exp_month: 12, exp_year: 2030 };
const base = { id: 'swell_pay_1', account_id: 'acc_1', amount: 10.5, currency: 'INR', card, intent: { razorpay: { id: 'pay_1' } } };
// Razorpay returns empty notes as an empty array
const authorized = { id: 'pay_1', status: 'authorized', amount: 1050, currency: 'INR', method: 'card', notes: [] };
const mine = { swell_payment_id: 'swell_pay_1' };
const other = { swell_payment_id: 'swell_pay_other' };

const success = (transactionId: string) => ({ success: true, transaction_id: transactionId });
const failure = (message: string) => ({ success: false, error: { message } });
const FAIL_CLOSED = 'Payment already captured but not recorded; contact support';

const ASYNC = { async: true };
const finished = (transactionId: string, captured = true) => [
  ['/payments/swell_pay_1', { transaction_id: transactionId, success: true, ...(captured && { captured: true }) }],
];
const failed = (message: string) => [['/payments/swell_pay_1', { success: false, error: { message } }]];

const LOOKUP = 'GET /orders?receipt=swell_pay_1&count=100';
// The earlier attempt, the order and the customer in parallel; then, in the background, the payment and
// its capture when Swell asks for the capture
const SAVED_CARD = [LOOKUP, 'POST /orders', 'POST /customers'];
const SAVED_CARD_CAPTURE = [...SAVED_CARD, 'POST /payments/create/recurring', 'POST /payments/pay_saved/capture'];
const SAVED_CARD_AUTHORIZE = [...SAVED_CARD, 'POST /payments/create/recurring'];
function expectSavedCardBodies(calls: Call[]) {
  expect(calls.find((call) => call.url.endsWith('/customers'))?.body).toEqual({
    name: 'Ada Lovelace', email: 'ada@example.com', contact: '+911234567890', fail_existing: '0',
  });
  // Razorpay does not capture a recurring payment for its order, so the capture is always explicit
  expect(calls.find((call) => call.url.endsWith('/orders'))?.body).toEqual({
    amount: 1050, currency: 'INR', payment_capture: false, receipt: 'swell_pay_1', notes: mine,
  });
  expect(calls.find((call) => call.url.endsWith('/payments/create/recurring'))?.body).toEqual({
    email: 'ada@example.com', contact: '+911234567890', amount: 1050, currency: 'INR',
    order_id: 'order_9', customer_id: 'cust_1', token: 'token_1', recurring: '1', notes: mine,
  });
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
}

describe('payment.charge', () => {
  describe('authorize phase (captured: false)', () => {
    it('accepts the shopper authorization without writing to it', async () => {
      const { calls } = fakeRazorpay([authorized]);
      expect(await charge(request({ ...base, captured: false }))).toEqual(success('pay_1'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('accepts an authorization already bound to this Swell payment', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, notes: mine }]);
      expect(await charge(request({ ...base, captured: false }))).toEqual(success('pay_1'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('compares the Swell currency in upper case', async () => {
      fakeRazorpay([authorized]);
      expect(await charge(request({ ...base, currency: 'inr', captured: false }))).toEqual(success('pay_1'));
    });

    it.each([
      ['bound to another Swell payment', { notes: other }],
      ['released or expired', { status: 'refunded' }],
      ['failed', { status: 'failed' }],
      ['of another amount', { amount: 999 }],
      ['in another currency', { currency: 'USD' }],
      ['not a card payment', { method: 'upi' }],
    ])('authorizes the saved card, without capturing, when the authorization is %s', async (_name, change) => {
      const { calls, payment } = fakeRazorpay([{ ...authorized, ...change }]);
      const req = request({ ...base, captured: false });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved', false));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', ...SAVED_CARD_AUTHORIZE]);
      expectSavedCardBodies(calls);
      expect(payment('pay_1')).toEqual({ ...authorized, ...change });
      expect(payment('pay_saved')).toMatchObject({ status: 'authorized' });
    });

    it('fails the Swell payment, naming the Razorpay payment, when the saved card payment is not authorized', async () => {
      const log = quietLog();
      fakeRazorpay([{ ...authorized, status: 'failed' }], { recurringStatus: 'failed' });
      const req = request({ ...base, captured: false });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('succeeds when Razorpay already captured the saved card payment, so the money is not orphaned', async () => {
      const { calls } = fakeRazorpay([], { recurringStatus: 'captured' });
      const { intent: _intent, ...data } = base;
      const req = request({ ...data, captured: false });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved', false));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
    });

    it('fails with the reason when the authorization is unusable and there is no saved card', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, amount: 999 }]);
      const { card: _card, ...data } = base;
      expect(await charge(request({ ...data, captured: false }))).toEqual(failure('Payment amount 999 INR does not match the order amount 1050 INR'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('fails closed for a captured authorization that no Swell payment recorded', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured' }]);
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure(FAIL_CLOSED));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('succeeds, without authorizing again, for a payment this Swell payment already captured', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured', notes: mine }]);
      expect(await charge(request({ ...base, captured: false }))).toEqual(success('pay_1'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('fails, without charging the saved card, for a payment it captured that does not match the order', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured', notes: mine, amount: 999 }]);
      expect(await charge(request({ ...base, captured: false }))).toEqual(failure('Payment amount 999 INR does not match the order amount 1050 INR'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('authorizes the saved card when there is no shopper authorization', async () => {
      const { calls } = fakeRazorpay([]);
      const { intent: _intent, ...data } = base;
      const req = request({ ...data, captured: false });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved', false));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expectSavedCardBodies(calls);
    });
  });

  describe('capture phase (captured: true or unset)', () => {
    it('captures the authorization, then records this Swell payment on it', async () => {
      const { calls, payment } = fakeRazorpay([{ ...authorized, notes: { cart: 'c1' } }]);
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_1'));
      expect(calls.map(({ method, url, body }) => [method, url.slice(API.length), body])).toEqual([
        ['GET', '/payments/pay_1', undefined],
        ['POST', '/payments/pay_1/capture', { amount: 1050, currency: 'INR' }],
        ['PATCH', '/payments/pay_1', { notes: { cart: 'c1', swell_payment_id: 'swell_pay_1' } }],
      ]);
      expect(payment('pay_1')).toMatchObject({ status: 'captured', notes: { swell_payment_id: 'swell_pay_1' } });
    });

    it('captures a merchant capture days later from the transaction id, without charging again', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, id: 'pay_2' }]);
      expect(await charge(request({ ...base, captured: true, transaction_id: 'pay_2' }))).toEqual(success('pay_2'));
      expect(summary(calls)).toEqual(['GET /payments/pay_2', 'POST /payments/pay_2/capture', 'PATCH /payments/pay_2']);
    });

    it('treats a missing captured flag as a capture request', async () => {
      const { calls } = fakeRazorpay([authorized]);
      expect(await charge(request(base))).toEqual(success('pay_1'));
      expect(summary(calls)).toContain('POST /payments/pay_1/capture');
    });

    it('captures its own saved card authorization from the authorize phase without writing again', async () => {
      const saved = { ...authorized, id: 'pay_saved', notes: mine };
      const { calls } = fakeRazorpay([authorized, saved]);
      expect(await charge(request({ ...base, captured: true, transaction_id: 'pay_saved' }))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(['GET /payments/pay_saved', 'POST /payments/pay_saved/capture']);
    });

    it('succeeds on a retry after its own capture without another call', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured', notes: mine }]);
      expect(await charge(request({ ...base, captured: true, transaction_id: 'pay_1' }))).toEqual(success('pay_1'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('fails, without charging the saved card, for a payment it captured that does not match the order', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured', notes: mine, amount: 999 }]);
      expect(await charge(request({ ...base, captured: true, transaction_id: 'pay_1' }))).toEqual(
        failure('Payment amount 999 INR does not match the order amount 1050 INR'),
      );
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('fails closed, never charging again, for a captured payment that no Swell payment recorded', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, status: 'captured' }]);
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure(FAIL_CLOSED));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });

    it('charges the saved card when another Swell payment wins the capture race', async () => {
      const { calls } = fakeRazorpay([authorized], { captures: { pay_1: 'taken' } });
      const req = request({ ...base, captured: true });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1', ...SAVED_CARD_CAPTURE]);
      expectSavedCardBodies(calls);
    });

    it('succeeds when a concurrent call of this Swell payment captured it first', async () => {
      const { calls } = fakeRazorpay([{ ...authorized, notes: mine }], { captures: { pay_1: 'lost' } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_1'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1']);
    });

    it('fails closed when the capture answer is lost and the payment is captured but unrecorded', async () => {
      const { calls } = fakeRazorpay([authorized], { captures: { pay_1: 'lost' } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure(FAIL_CLOSED));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1']);
    });

    it('charges the saved card when the authorization expired at capture time', async () => {
      const { calls } = fakeRazorpay([authorized], { captures: { pay_1: 'expired' } });
      const req = request({ ...base, captured: true });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls).slice(3)).toEqual(SAVED_CARD_CAPTURE);
    });

    it('charges the saved card when Razorpay refuses the capture and the authorization is still usable', async () => {
      const { calls, payment } = fakeRazorpay([authorized], { captures: { pay_1: 'refused' } });
      const req = request({ ...base, captured: true });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1', ...SAVED_CARD_CAPTURE]);
      expect(payment('pay_1')).toEqual(authorized);
    });

    it.each([
      ['fails with a 5xx', 'error', 'Razorpay: Gateway timeout'],
      ['is rate limited', 'throttled', 'Razorpay: Too many requests'],
      ['gets no answer', 'offline', 'fetch failed'],
    ] as const)('fails, without charging the saved card, when the capture %s and the authorization is still usable', async (_name, mode, message) => {
      const { calls, payment } = fakeRazorpay([authorized], { captures: { pay_1: mode } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(failure(message));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1']);
      expect(payment('pay_1')).toEqual(authorized);
    });

    it('fails with the capture error when the capture fails and there is no saved card', async () => {
      const { calls } = fakeRazorpay([authorized], { captures: { pay_1: 'error' } });
      const { card: _card, ...data } = base;
      expect(await charge(request({ ...data, captured: true }))).toEqual(failure('Razorpay: Gateway timeout'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/capture', 'GET /payments/pay_1']);
    });

    it('still succeeds when recording the owner fails after a successful capture', async () => {
      const log = quietLog();
      fakeRazorpay([authorized], { patch: 'error' });
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_1'));
      expect(log).toHaveBeenCalledOnce();
    });

    it.each([
      ['bound to another Swell payment', { notes: other }],
      ['captured for another Swell payment', { status: 'captured', notes: other }],
      ['released or expired', { status: 'refunded' }],
      ['of another amount', { amount: 999 }],
      ['in another currency', { currency: 'USD' }],
      ['not a card payment', { method: 'netbanking' }],
    ])('charges the saved card, leaving the authorization alone, when it is %s', async (_name, change) => {
      const { calls, payment } = fakeRazorpay([{ ...authorized, ...change }]);
      const req = request({ ...base, captured: true });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', ...SAVED_CARD_CAPTURE]);
      expectSavedCardBodies(calls);
      expect(payment('pay_1')).toEqual({ ...authorized, ...change });
      expect(payment('pay_saved')).toMatchObject({ status: 'captured' });
    });

    it.each([
      ['bound to another Swell payment', { notes: other }, 'Payment belongs to another order'],
      ['not authorized', { status: 'failed' }, 'Payment is not authorized (status: failed)'],
      ['in another currency', { currency: 'USD' }, 'Payment amount 1050 USD does not match the order amount 1050 INR'],
      ['not a card payment', { method: 'upi' }, 'Payment is not a card payment (method: upi)'],
    ])('fails with the reason when the authorization is %s and there is no saved card', async (_name, change, message) => {
      const { calls } = fakeRazorpay([{ ...authorized, ...change }]);
      const { card: _card, ...data } = base;
      expect(await charge(request({ ...data, captured: true }))).toEqual(failure(message));
      expect(summary(calls)).toEqual(['GET /payments/pay_1']);
    });
  });

  describe('new saved card payment (finished in the background)', () => {
    const { intent: _intent, ...renewal } = base;

    it('answers pending before Razorpay answers the payment, then captures it and finishes the Swell payment', async () => {
      let answer!: () => void;
      const { calls, payment } = fakeRazorpay([], { recurringGate: new Promise<void>((resolve) => (answer = resolve)) });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(req.swell.put).not.toHaveBeenCalledWith(expect.stringMatching(/^\/payments\//), expect.anything());
      expect(req.background).toHaveLength(1);
      answer();
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_CAPTURE);
      expectSavedCardBodies(calls);
      expect(calls.at(-1)?.body).toEqual({ amount: 1050, currency: 'INR' });
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', notes: mine });
    });

    it('authorizes it without capturing in the authorize phase', async () => {
      const { calls, payment } = fakeRazorpay([]);
      const req = request({ ...renewal, captured: false });
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved', false));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expectSavedCardBodies(calls);
      expect(payment('pay_saved')).toMatchObject({ status: 'authorized' });
    });

    it('reads it when Razorpay answers without a valid signature, and captures it when it is authorized', async () => {
      const { calls } = fakeRazorpay([], { recurringSignature: false });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual([...SAVED_CARD_AUTHORIZE, 'GET /payments/pay_saved', 'POST /payments/pay_saved/capture']);
    });

    it('fails the Swell payment, naming the Razorpay payment, when it is neither authorized nor captured', async () => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { recurringStatus: 'failed' });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(failed('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
      expect(summary(calls)).toEqual([...SAVED_CARD_AUTHORIZE, 'GET /payments/pay_saved']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('leaves the Swell payment pending while Razorpay waits to debit it (live pre-debit)', async () => {
      const { calls } = fakeRazorpay([], { recurringStatus: 'created' });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual([]);
      expect(summary(calls)).toEqual([...SAVED_CARD_AUTHORIZE, 'GET /payments/pay_saved']);
    });

    it.each([
      ['refused', 'Razorpay: Capture amount is invalid'],
      ['expired', 'Razorpay: Payment authorization has expired'],
    ] as const)('fails the Swell payment, naming the Razorpay payment, when the capture is %s and it is not captured', async (mode, message) => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { captures: { pay_saved: mode } });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(failed(`Saved card payment pay_saved was not finalized: ${message}`));
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('finishes the Swell payment when the capture answer is lost but Razorpay captured it', async () => {
      const { calls } = fakeRazorpay([], { captures: { pay_saved: 'lost' } });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
    });

    it.each([
      ['fails with a 5xx', 'error'],
      ['is rate limited', 'throttled'],
      ['gets no answer', 'offline'],
    ] as const)('leaves the Swell payment pending when the capture %s and it is still authorized', async (_name, mode) => {
      const log = quietLog();
      const { calls, payment } = fakeRazorpay([], { captures: { pay_saved: mode } });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual([]);
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
      expect(payment('pay_saved')).toMatchObject({ status: 'authorized' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('leaves the Swell payment pending when the create/recurring answer is lost', async () => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { loseRecurring: true });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual([]);
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('swell_pay_1'));
    });

    it('fails the Swell payment when Razorpay refuses the create/recurring', async () => {
      const log = quietLog();
      fakeRazorpay([], { refuseRecurring: true });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(failed('Razorpay: The token is invalid'));
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('swell_pay_1'));
    });

    it('leaves the Swell payment pending when it has no signature and can not be read', async () => {
      const log = quietLog();
      fakeRazorpay([], { recurringSignature: false, failGet: ['pay_saved'] });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('logs a write to the Swell payment that fails', async () => {
      const log = quietLog();
      fakeRazorpay([]);
      const req = request(renewal);
      req.swell.put.mockImplementation(async (url: string) => {
        if (url.startsWith('/payments/')) throw new Error('Swell is down');
      });
      expect(await charge(req)).toEqual(ASYNC);
      await writesOf(req);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });
  });

  describe('saved card payment of an earlier attempt (found by its order receipt)', () => {
    const { intent: _intent, ...renewal } = base;
    const earlierOrder = { id: 'order_1', amount: 1050, currency: 'INR', receipt: 'swell_pay_1', notes: mine };
    const earlier = { id: 'pay_old', status: 'captured', amount: 1050, currency: 'INR', method: 'card', order_id: 'order_1', notes: mine };
    // The order and the customer for a new payment are prepared in parallel; what matters is what follows
    const PARALLEL = ['POST /orders', 'POST /customers'];
    const after = (calls: Call[]) => summary(calls).filter((call) => !PARALLEL.includes(call));
    const REUSE = [LOOKUP, 'GET /orders/order_1/payments', 'GET /payments/pay_old'];

    it('reuses its captured payment on a retry, without a new payment', async () => {
      const { calls } = fakeRazorpay([earlier], { orders: [earlierOrder] });
      const req = request(renewal);
      expect(await charge(req)).toEqual(success('pay_old'));
      expect(after(calls)).toEqual(REUSE);
      // Finished synchronously: nothing left for the background
      expect(req.background).toEqual([]);
    });

    it('captures its authorized payment in the capture phase', async () => {
      const { calls, payment } = fakeRazorpay([{ ...earlier, status: 'authorized' }], { orders: [earlierOrder] });
      const req = request(renewal);
      expect(await charge(req)).toEqual(success('pay_old'));
      expect(req.background).toEqual([]);
      expect(after(calls)).toEqual([...REUSE, 'POST /payments/pay_old/capture']);
      expect(payment('pay_old')).toMatchObject({ status: 'captured' });
    });

    it('accepts its authorized payment in the authorize phase without capturing', async () => {
      const { calls } = fakeRazorpay([{ ...earlier, status: 'authorized' }], { orders: [earlierOrder] });
      expect(await charge(request({ ...renewal, captured: false }))).toEqual(success('pay_old'));
      expect(after(calls)).toEqual(REUSE);
    });

    it('prefers a captured payment to an authorized one of another attempt', async () => {
      const laterOrder = { ...earlierOrder, id: 'order_2' };
      const held = { ...earlier, id: 'pay_held', status: 'authorized' };
      const { calls } = fakeRazorpay([held, { ...earlier, order_id: 'order_2' }], { orders: [earlierOrder, laterOrder] });
      expect(await charge(request(renewal))).toEqual(success('pay_old'));
      expect(after(calls)).toEqual([LOOKUP, 'GET /orders/order_1/payments', 'GET /orders/order_2/payments', 'GET /payments/pay_old']);
    });

    it('finalizes the payment whose create/recurring answer was lost on the retry', async () => {
      quietLog();
      const { calls, payment } = fakeRazorpay([], { loseRecurring: true });
      const first = request(renewal);
      expect(await charge(first)).toEqual(ASYNC);
      expect(await writesOf(first)).toEqual([]);
      calls.length = 0;
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(after(calls)).toEqual([LOOKUP, 'GET /orders/order_9/payments', 'GET /payments/pay_saved', 'POST /payments/pay_saved/capture']);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', order_id: 'order_9' });
    });

    it('creates a new payment when the earlier ones took nothing or do not match the order', async () => {
      const ignored = [
        { ...earlier, id: 'pay_failed', status: 'failed' },
        { ...earlier, id: 'pay_released', status: 'refunded' },
        { ...earlier, id: 'pay_other_amount', status: 'authorized', amount: 999 },
        { ...earlier, id: 'pay_other_method', status: 'authorized', method: 'upi' },
      ];
      const { calls } = fakeRazorpay(ignored, { orders: [earlierOrder] });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(after(calls)).toEqual([LOOKUP, 'GET /orders/order_1/payments', 'POST /payments/create/recurring', 'POST /payments/pay_saved/capture']);
      expectSavedCardBodies(calls);
    });

    it('fails, without charging again, when its captured payment does not match the order', async () => {
      const { calls } = fakeRazorpay([{ ...earlier, amount: 999 }], { orders: [earlierOrder] });
      expect(await charge(request(renewal))).toEqual(failure('Payment amount 999 INR does not match the order amount 1050 INR'));
      expect(after(calls)).toEqual(REUSE.slice(0, 2));
    });

    it('fails, without charging again, when its payment is still pending', async () => {
      const { calls } = fakeRazorpay([{ ...earlier, status: 'created' }], { orders: [earlierOrder] });
      const req = request(renewal);
      expect(await charge(req)).toEqual(failure('Saved card payment pay_old is still pending (status: created); contact support'));
      expect(after(calls)).toEqual(REUSE.slice(0, 2));
      expect(req.background).toEqual([]);
    });

    it('ignores orders of another receipt', async () => {
      const otherOrder = { ...earlierOrder, id: 'order_2', receipt: 'swell_pay_other', notes: other };
      const { calls } = fakeRazorpay([{ ...earlier, order_id: 'order_2', notes: other }], { orders: [otherOrder], receiptFilter: false });
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(after(calls)).toEqual([LOOKUP, 'POST /payments/create/recurring', 'POST /payments/pay_saved/capture']);
    });

    it.each([
      ['the orders', 'orders', [LOOKUP]],
      ['the order payments', 'payments', [LOOKUP, 'GET /orders/order_1/payments']],
    ] as const)('fails, without creating a payment, when %s can not be listed', async (_name, failLookup, lookups) => {
      const { calls } = fakeRazorpay([earlier], { orders: [earlierOrder], failLookup });
      const req = request(renewal);
      expect(await charge(req)).toEqual(failure('Razorpay: Service unavailable'));
      expect(after(calls)).toEqual(lookups);
      expect(req.background).toEqual([]);
    });
  });

  describe('without a shopper authorization (subscription renewal, admin charge)', () => {
    const { intent: _intent, ...renewal } = base;

    it('charges the saved card, captured and bound at creation', async () => {
      const { calls, payment } = fakeRazorpay([]);
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_CAPTURE);
      expectSavedCardBodies(calls);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', notes: mine });
    });

    it.each([
      ['the billing phone', { ...account, phone: undefined }, '+910000000001'],
      ['the shipping phone', { ...account, phone: undefined, billing: undefined }, '+910000000002'],
    ])('falls back to %s as the contact', async (_name, shopper, contact) => {
      const { calls } = fakeRazorpay([]);
      const req = request(renewal, shopper);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(calls.find((call) => call.url.endsWith('/customers'))?.body.contact).toBe(contact);
      expect(calls.find((call) => call.url.endsWith('/payments/create/recurring'))?.body.contact).toBe(contact);
    });

    it('charges for the customer kept on the account, without creating one', async () => {
      const { calls } = fakeRazorpay([]);
      const shopper = { ...account, phone: '+910000000009', $app: { razorpay: { customer_id: 'cust_kept', contact: '+919999999999' } } };
      const req = request(renewal, shopper);
      expect(await charge(req)).toEqual(ASYNC);
      expect(await writesOf(req)).toEqual(finished('pay_saved'));
      expect(summary(calls)).not.toContain('POST /customers');
      expect(calls.find((call) => call.url.endsWith('/payments/create/recurring'))?.body).toMatchObject({
        customer_id: 'cust_kept', contact: '+919999999999', email: 'ada@example.com',
      });
      expect(req.swell.put).not.toHaveBeenCalledWith(expect.stringMatching(/^\/accounts\//), expect.anything());
    });

    it('keeps the customer it found on the account', async () => {
      fakeRazorpay([]);
      const req = request(renewal);
      expect(await charge(req)).toEqual(ASYNC);
      expect(req.swell.put).toHaveBeenCalledWith('/accounts/acc_1', { $app: { razorpay: { customer_id: 'cust_1', contact: '+911234567890' } } });
    });

    it('fails without a phone number, before creating a payment', async () => {
      const { calls } = fakeRazorpay([]);
      const shopper = { name: 'Ada', email: 'ada@example.com', billing: {}, shipping: {} };
      const req = request(renewal, shopper);
      expect(await charge(req)).toEqual(failure('A phone number is required to charge the saved card'));
      // Only what runs in parallel reached Razorpay: the lookup and an order no payment ever uses
      expect(summary(calls)).toEqual([LOOKUP, 'POST /orders']);
      expect(req.background).toEqual([]);
    });

    it('fails when the order can not be created, before creating a payment', async () => {
      const { calls } = fakeRazorpay([], { failOrder: true });
      const req = request(renewal);
      expect(await charge(req)).toEqual(failure('Razorpay: Service unavailable'));
      expect(summary(calls)).toEqual(SAVED_CARD);
      expect(req.background).toEqual([]);
    });

    it('fails without an email address, before creating a payment', async () => {
      const { calls } = fakeRazorpay([]);
      expect(await charge(request(renewal, { ...account, email: ' ' }))).toEqual(failure('An email address is required to charge the saved card'));
      // Only what runs in parallel reached Razorpay: the lookup and an order no payment ever uses
      expect(summary(calls)).toEqual([LOOKUP, 'POST /orders']);
    });

    it('fails without an account', async () => {
      const { calls } = fakeRazorpay([]);
      const { account_id: _account, ...data } = renewal;
      expect(await charge(request(data))).toEqual(failure('No account for this charge'));
      expect(calls).toEqual([]);
    });

    it('fails without a saved card', async () => {
      const { calls } = fakeRazorpay([]);
      const { card: _card, ...data } = renewal;
      expect(await charge(request(data))).toEqual(failure('No Razorpay payment or saved card for this charge'));
      expect(calls).toEqual([]);
    });
  });

  it('prefers the transaction id of the authorize phase to the intent', async () => {
    const { calls } = fakeRazorpay([authorized, { ...authorized, id: 'pay_saved', notes: mine }]);
    await charge(request({ ...base, captured: true, transaction_id: 'pay_saved' }));
    expect(calls[0].url).toBe(`${API}/payments/pay_saved`);
  });

  it('fails, without charging the saved card, when the payment cannot be read', async () => {
    const { calls } = fakeRazorpay([]);
    expect(await charge(request({ ...base, captured: true }))).toEqual(failure('Razorpay: The id provided does not exist'));
    expect(summary(calls)).toEqual(['GET /payments/pay_1']);
  });

  it('fails without the Swell payment id, before calling Razorpay', async () => {
    const { calls } = fakeRazorpay([authorized]);
    const { id: _id, ...data } = base;
    expect(await charge(request({ ...data, captured: false }))).toEqual(failure('No Swell payment for this charge'));
    expect(calls).toEqual([]);
  });

  it.each([
    ['amount', { amount: undefined }, 'Invalid amount'],
    ['currency', { currency: '' }, 'Invalid currency'],
  ])('fails for an invalid %s, before calling Razorpay', async (_name, change, message) => {
    const { calls } = fakeRazorpay([authorized]);
    expect(await charge(request({ ...base, ...change }))).toEqual(failure(message));
    expect(calls).toEqual([]);
  });
});
