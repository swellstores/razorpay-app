import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import charge from '../functions/card-charge';

const API = 'https://api.razorpay.com/v1';
const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };
const account = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+911234567890', billing: { phone: '+910000000001' }, shipping: { phone: '+910000000002' } };

function request(data: Record<string, unknown>, shopper: Record<string, unknown> | undefined = account) {
  const get = vi.fn(async (url: string) => (url === '/accounts/acc_1' ? shopper : null));
  return { appId: 'razorpay', data, appValues: (values: object) => ({ $app: { razorpay: values } }), swell: { settings: vi.fn(async () => settings), get, put: vi.fn(async () => ({})) } } as any;
}

type Call = { method: string; url: string; body?: any };
type CaptureMode = 'taken' | 'lost' | 'refused' | 'error' | 'throttled' | 'offline' | 'expired';

/**
 * Fake Razorpay around a set of payments and orders. GET and PATCH read and update payments; capture marks
 * one captured. `captures` per payment id: 'taken' — another Swell payment captured and claimed it first,
 * the call answers with an error; 'lost' — Razorpay captured it but the answer was lost; 'refused' —
 * Razorpay refused it (4xx), still authorized; 'error' — failed with a 5xx, still authorized; 'throttled' —
 * rate limited (429), still authorized; 'offline' —
 * no answer (fetch rejects), still authorized; 'expired' — failed because the authorization was released.
 * POST /orders stores `order_9`; GET /orders?receipt= lists the orders with that receipt (all of them with
 * `receiptFilter: false`), and GET /orders/{id}/payments the payments with that `order_id`.
 * The saved card payment (`pay_saved`) comes back `authorized`, as Razorpay answers right after
 * create/recurring, unless `recurringStatus` says otherwise; `recurringNotes: false` drops its notes;
 * `loseRecurring` loses the first create/recurring answer after creating the payment.
 * GET of an id in `failGet` answers with an error; `failLookup` fails the orders or order payments list.
 */
function fakeRazorpay(
  payments: Record<string, unknown>[],
  {
    orders = [], captures = {}, recurringStatus = 'authorized', recurringNotes = true, recurringSignature = true, loseRecurring = false,
    receiptFilter = true, failGet = [], failLookup, patch,
  }: {
    orders?: Record<string, unknown>[];
    captures?: Record<string, CaptureMode>;
    recurringStatus?: string;
    recurringNotes?: boolean;
    recurringSignature?: boolean;
    loseRecurring?: boolean;
    receiptFilter?: boolean;
    failGet?: string[];
    failLookup?: 'orders' | 'payments';
    patch?: 'error';
  } = {},
) {
  const store = new Map(payments.map((payment) => [payment.id as string, { ...payment }]));
  const orderStore = new Map(orders.map((order) => [order.id as string, { ...order }]));
  const calls: Call[] = [];
  let lose = loseRecurring;
  const fail = (status: number, description: string) => Response.json({ error: { description } }, { status });
  const list = (items: unknown[]) => Response.json({ entity: 'collection', count: items.length, items });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.slice(API.length);
    if (path === '/customers') return Response.json({ id: 'cust_1' });
    if (path === '/orders' && method === 'POST') {
      const order = { id: 'order_9', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, payment_capture: body.payment_capture };
      orderStore.set(order.id, order);
      return Response.json(order);
    }
    if (path.startsWith('/orders?')) {
      if (failLookup === 'orders') return fail(503, 'Service unavailable');
      const receipt = new URL(url).searchParams.get('receipt');
      return list([...orderStore.values()].filter((order) => !receiptFilter || order.receipt === receipt));
    }
    const [, orderId] = path.match(/^\/orders\/([^/?]+)\/payments$/) ?? [];
    if (orderId) {
      if (failLookup === 'payments') return fail(503, 'Service unavailable');
      return list([...store.values()].filter((payment) => payment.order_id === orderId));
    }
    if (path === '/payments/create/recurring') {
      const notes = recurringNotes ? body.notes : [];
      store.set('pay_saved', { id: 'pay_saved', status: recurringStatus, amount: body.amount, currency: body.currency, method: 'card', order_id: body.order_id, notes });
      if (lose) {
        lose = false;
        return fail(504, 'Gateway timeout');
      }
      // Razorpay signs a successful payment with the order, as the checkout modal does
      const signed = recurringSignature && ['authorized', 'captured'].includes(recurringStatus);
      // Razorpay answers `authorized`, then the order's auto capture captures it
      if (recurringStatus === 'authorized' && orderStore.get(body.order_id)?.payment_capture) {
        store.set('pay_saved', { ...store.get('pay_saved')!, status: 'captured' });
      }
      const signature = createHmac('sha256', settings.key_secret).update(`${body.order_id}|pay_saved`).digest('hex');
      return Response.json({ razorpay_payment_id: 'pay_saved', razorpay_order_id: body.order_id, ...(signed && { razorpay_signature: signature }) });
    }
    const [, id, action] = path.match(/^\/payments\/([^/?]+)(?:\/(\w+))?/) ?? [];
    const payment = store.get(id);
    if (!payment) return fail(400, 'The id provided does not exist');
    if (method === 'PATCH') {
      if (patch === 'error') return fail(502, 'Bad gateway');
      store.set(id, { ...payment, notes: body.notes });
    } else if (action === 'capture') {
      if (payment.status === 'captured') return fail(400, 'This payment has already been captured');
      if (payment.status !== 'authorized') return fail(400, 'Only payments which have been authorized and not yet captured can be captured');
      const mode = captures[id];
      if (mode === 'refused') return fail(400, 'Capture amount is invalid');
      if (mode === 'error') return fail(502, 'Gateway timeout');
      if (mode === 'throttled') return fail(429, 'Too many requests');
      if (mode === 'offline') throw new TypeError('fetch failed');
      if (mode === 'expired') {
        store.set(id, { ...payment, status: 'refunded' });
        return fail(400, 'Payment authorization has expired');
      }
      if (mode === 'taken') {
        store.set(id, { ...payment, status: 'captured', notes: { swell_payment_id: 'swell_pay_other' } });
        return fail(400, 'This payment has already been captured');
      }
      store.set(id, { ...payment, status: 'captured' });
      if (mode === 'lost') return fail(504, 'Gateway timeout');
    } else if (failGet.includes(id)) {
      return fail(503, 'Service unavailable');
    }
    return Response.json(store.get(id));
  }));
  return { calls, payment: (id: string) => store.get(id), order: (id: string) => orderStore.get(id) };
}

afterEach(() => {
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
const summary = (calls: Call[]) => calls.map(({ method, url }) => `${method} ${url.slice(API.length)}`);

const LOOKUP = 'GET /orders?receipt=swell_pay_1&count=100';
// The earlier attempt, the order and the customer in parallel, then the payment: no capture call, the
// order captures it when Swell asks for the capture
const SAVED_CARD_CAPTURE = [LOOKUP, 'POST /orders', 'POST /customers', 'POST /payments/create/recurring'];
const SAVED_CARD_AUTHORIZE = SAVED_CARD_CAPTURE;
function expectSavedCardBodies(calls: Call[], capture = true) {
  expect(calls.find((call) => call.url.endsWith('/customers'))?.body).toEqual({
    name: 'Ada Lovelace', email: 'ada@example.com', contact: '+911234567890', fail_existing: '0',
  });
  // The order captures the payment only when Swell asks for the capture
  expect(calls.find((call) => call.url.endsWith('/orders'))?.body).toEqual({
    amount: 1050, currency: 'INR', payment_capture: capture, receipt: 'swell_pay_1', notes: mine,
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
      expect(await charge(request({ ...base, captured: false }))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(['GET /payments/pay_1', ...SAVED_CARD_AUTHORIZE]);
      expectSavedCardBodies(calls, false);
      expect(payment('pay_1')).toEqual({ ...authorized, ...change });
      expect(payment('pay_saved')).toMatchObject({ status: 'authorized' });
    });

    it('fails, naming the Razorpay payment, when the saved card payment is not authorized', async () => {
      const log = quietLog();
      fakeRazorpay([{ ...authorized, status: 'failed' }], { recurringStatus: 'failed' });
      const result = await charge(request({ ...base, captured: false }));
      expect(result).toEqual(failure('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('succeeds when Razorpay already captured the saved card payment, so the money is not orphaned', async () => {
      const { calls } = fakeRazorpay([], { recurringStatus: 'captured' });
      const { intent: _intent, ...data } = base;
      expect(await charge(request({ ...data, captured: false }))).toEqual(success('pay_saved'));
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
      expect(await charge(request({ ...data, captured: false }))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expectSavedCardBodies(calls, false);
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
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_saved'));
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
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_saved'));
      expect(summary(calls).slice(3)).toEqual(SAVED_CARD_CAPTURE);
    });

    it('charges the saved card when Razorpay refuses the capture and the authorization is still usable', async () => {
      const { calls, payment } = fakeRazorpay([authorized], { captures: { pay_1: 'refused' } });
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_saved'));
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
      expect(await charge(request({ ...base, captured: true }))).toEqual(success('pay_saved'));
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

  describe('new saved card payment', () => {
    const { intent: _intent, ...renewal } = base;

    it('leaves the capture to its order, without a capture call or a read', async () => {
      const { calls, payment } = fakeRazorpay([]);
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_CAPTURE);
      expectSavedCardBodies(calls);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', notes: mine });
    });

    it('reads it when Razorpay answers without a valid signature, and succeeds when it is authorized', async () => {
      const { calls } = fakeRazorpay([], { recurringSignature: false });
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
    });

    it('fails, naming the Razorpay payment, when it is neither authorized nor captured', async () => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { recurringStatus: 'failed' });
      expect(await charge(request(renewal))).toEqual(failure('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('fails, naming the Razorpay payment, when it has no signature and can not be read', async () => {
      const log = quietLog();
      fakeRazorpay([], { recurringSignature: false, failGet: ['pay_saved'] });
      expect(await charge(request(renewal))).toEqual(failure('Saved card payment pay_saved was not finalized: Razorpay: Service unavailable'));
      expect(log).toHaveBeenCalledOnce();
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
      expect(await charge(request(renewal))).toEqual(success('pay_old'));
      expect(after(calls)).toEqual(REUSE);
    });

    it('captures its authorized payment in the capture phase', async () => {
      const { calls, payment } = fakeRazorpay([{ ...earlier, status: 'authorized' }], { orders: [earlierOrder] });
      expect(await charge(request(renewal))).toEqual(success('pay_old'));
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
      const log = quietLog();
      const { calls, payment } = fakeRazorpay([], { loseRecurring: true });
      expect(await charge(request(renewal))).toEqual(failure('Razorpay: Gateway timeout'));
      expect(log).not.toHaveBeenCalled();
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
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(after(calls)).toEqual([LOOKUP, 'GET /orders/order_1/payments', 'POST /payments/create/recurring']);
      expectSavedCardBodies(calls);
    });

    it('fails, without charging again, when its captured payment does not match the order', async () => {
      const { calls } = fakeRazorpay([{ ...earlier, amount: 999 }], { orders: [earlierOrder] });
      expect(await charge(request(renewal))).toEqual(failure('Payment amount 999 INR does not match the order amount 1050 INR'));
      expect(after(calls)).toEqual(REUSE.slice(0, 2));
    });

    it('fails, without charging again, when its payment is still pending', async () => {
      const { calls } = fakeRazorpay([{ ...earlier, status: 'created' }], { orders: [earlierOrder] });
      expect(await charge(request(renewal))).toEqual(failure('Saved card payment pay_old is still pending (status: created); contact support'));
      expect(after(calls)).toEqual(REUSE.slice(0, 2));
    });

    it('ignores orders of another receipt', async () => {
      const otherOrder = { ...earlierOrder, id: 'order_2', receipt: 'swell_pay_other', notes: other };
      const { calls } = fakeRazorpay([{ ...earlier, order_id: 'order_2', notes: other }], { orders: [otherOrder], receiptFilter: false });
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(after(calls)).toEqual([LOOKUP, 'POST /payments/create/recurring']);
    });

    it.each([
      ['the orders', 'orders', [LOOKUP]],
      ['the order payments', 'payments', [LOOKUP, 'GET /orders/order_1/payments']],
    ] as const)('fails, without creating a payment, when %s can not be listed', async (_name, failLookup, lookups) => {
      const { calls } = fakeRazorpay([earlier], { orders: [earlierOrder], failLookup });
      expect(await charge(request(renewal))).toEqual(failure('Razorpay: Service unavailable'));
      expect(after(calls)).toEqual(lookups);
    });
  });

  describe('without a shopper authorization (subscription renewal, admin charge)', () => {
    const { intent: _intent, ...renewal } = base;

    it('charges the saved card, captured and bound at creation', async () => {
      const { calls, payment } = fakeRazorpay([]);
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_CAPTURE);
      expectSavedCardBodies(calls);
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', notes: mine });
    });

    it.each([
      ['the billing phone', { ...account, phone: undefined }, '+910000000001'],
      ['the shipping phone', { ...account, phone: undefined, billing: undefined }, '+910000000002'],
    ])('falls back to %s as the contact', async (_name, shopper, contact) => {
      const { calls } = fakeRazorpay([]);
      expect(await charge(request(renewal, shopper))).toEqual(success('pay_saved'));
      expect(calls.find((call) => call.url.endsWith('/customers'))?.body.contact).toBe(contact);
      expect(calls.find((call) => call.url.endsWith('/payments/create/recurring'))?.body.contact).toBe(contact);
    });

    it('charges for the customer kept on the account, without creating one', async () => {
      const { calls } = fakeRazorpay([]);
      const shopper = { ...account, phone: '+910000000009', $app: { razorpay: { customer_id: 'cust_kept', contact: '+919999999999' } } };
      const req = request(renewal, shopper);
      expect(await charge(req)).toEqual(success('pay_saved'));
      expect(summary(calls)).not.toContain('POST /customers');
      expect(calls.find((call) => call.url.endsWith('/payments/create/recurring'))?.body).toMatchObject({
        customer_id: 'cust_kept', contact: '+919999999999', email: 'ada@example.com',
      });
      expect(req.swell.put).not.toHaveBeenCalled();
    });

    it('keeps the customer it found on the account', async () => {
      fakeRazorpay([]);
      const req = request(renewal);
      expect(await charge(req)).toEqual(success('pay_saved'));
      expect(req.swell.put).toHaveBeenCalledWith('/accounts/acc_1', { $app: { razorpay: { customer_id: 'cust_1', contact: '+911234567890' } } });
    });

    it('fails without a phone number, before creating a payment', async () => {
      const { calls } = fakeRazorpay([]);
      const shopper = { name: 'Ada', email: 'ada@example.com', billing: {}, shipping: {} };
      expect(await charge(request(renewal, shopper))).toEqual(failure('A phone number is required to charge the saved card'));
      // Only what runs in parallel reached Razorpay: the lookup and an order no payment ever uses
      expect(summary(calls)).toEqual([LOOKUP, 'POST /orders']);
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
