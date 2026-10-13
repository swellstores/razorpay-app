import { afterEach, describe, expect, it, vi } from 'vitest';

import charge from '../functions/card-charge';

const API = 'https://api.razorpay.com/v1';
const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };
const account = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+911234567890', billing: { phone: '+910000000001' }, shipping: { phone: '+910000000002' } };

function request(data: Record<string, unknown>, shopper: Record<string, unknown> | undefined = account) {
  const get = vi.fn(async (url: string) => (url === '/accounts/acc_1' ? shopper : null));
  return { appId: 'razorpay', data, swell: { settings: vi.fn(async () => settings), get } } as any;
}

type Call = { method: string; url: string; body?: any };
type CaptureMode = 'taken' | 'lost' | 'refused' | 'error' | 'offline' | 'expired';

/**
 * Fake Razorpay around a set of payments. GET and PATCH read and update them; capture marks one captured.
 * `captures` per payment id: 'taken' — another Swell payment captured and claimed it first, the call
 * answers with an error; 'lost' — Razorpay captured it but the answer was lost; 'refused' — Razorpay
 * refused it (4xx), still authorized; 'error' — failed with a 5xx, still authorized; 'offline' — no answer
 * (fetch rejects), still authorized; 'expired' — failed because the authorization was released.
 * The saved card payment (`pay_saved`) comes back `authorized`, as Razorpay answers right after
 * create/recurring, unless `recurringStatus` says otherwise; `recurringNotes: false` drops its notes.
 * GET of an id in `failGet` answers with an error.
 */
function fakeRazorpay(
  payments: Record<string, unknown>[],
  { captures = {}, recurringStatus = 'authorized', recurringNotes = true, failGet = [], patch }: {
    captures?: Record<string, CaptureMode>;
    recurringStatus?: string;
    recurringNotes?: boolean;
    failGet?: string[];
    patch?: 'error';
  } = {},
) {
  const store = new Map(payments.map((payment) => [payment.id as string, { ...payment }]));
  const calls: Call[] = [];
  const fail = (status: number, description: string) => Response.json({ error: { description } }, { status });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.slice(API.length);
    if (path === '/customers') return Response.json({ id: 'cust_1' });
    if (path === '/orders') return Response.json({ id: 'order_9', amount: body.amount, currency: body.currency });
    if (path === '/payments/create/recurring') {
      const notes = recurringNotes ? body.notes : [];
      store.set('pay_saved', { id: 'pay_saved', status: recurringStatus, amount: body.amount, currency: body.currency, method: 'card', order_id: body.order_id, notes });
      return Response.json({ razorpay_payment_id: 'pay_saved', razorpay_order_id: body.order_id });
    }
    const [, id, action] = path.match(/^\/payments\/([^/?]+)(?:\/(\w+))?/) ?? [];
    const payment = store.get(id);
    if (!payment) return fail(400, 'The id provided does not exist');
    if (method === 'PATCH') {
      if (patch === 'error') return fail(502, 'Bad gateway');
      store.set(id, { ...payment, notes: body.notes });
    } else if (action === 'capture') {
      const mode = captures[id];
      if (mode === 'refused') return fail(400, 'Capture amount is invalid');
      if (mode === 'error') return fail(502, 'Gateway timeout');
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
  return { calls, payment: (id: string) => store.get(id) };
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

const SAVED_CARD_AUTHORIZE = ['POST /customers', 'POST /orders', 'POST /payments/create/recurring', 'GET /payments/pay_saved'];
const SAVED_CARD_CAPTURE = [...SAVED_CARD_AUTHORIZE, 'POST /payments/pay_saved/capture'];
function expectSavedCardBodies(calls: Call[]) {
  expect(calls.find((call) => call.url.endsWith('/customers'))?.body).toEqual({
    name: 'Ada Lovelace', email: 'ada@example.com', contact: '+911234567890', fail_existing: '0',
  });
  // Always authorize only: Razorpay answers `authorized` right after create/recurring, the capture is explicit
  expect(calls.find((call) => call.url.endsWith('/orders'))?.body).toEqual({
    amount: 1050, currency: 'INR', payment_capture: false, notes: mine,
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
      expectSavedCardBodies(calls);
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

  describe('saved card payment (capture phase)', () => {
    const { intent: _intent, ...renewal } = base;

    it('captures the authorized saved card payment explicitly', async () => {
      const { calls, payment } = fakeRazorpay([]);
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(calls.map(({ method, url, body }) => [method, url.slice(API.length), body]).at(-1)).toEqual(
        ['POST', '/payments/pay_saved/capture', { amount: 1050, currency: 'INR' }],
      );
      expect(payment('pay_saved')).toMatchObject({ status: 'captured', notes: mine });
    });

    it('succeeds without capturing when Razorpay already captured it', async () => {
      const { calls } = fakeRazorpay([], { recurringStatus: 'captured' });
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
    });

    it('succeeds when the capture answer is lost but it is captured, even without notes', async () => {
      const { calls } = fakeRazorpay([], { captures: { pay_saved: 'lost' }, recurringNotes: false });
      expect(await charge(request(renewal))).toEqual(success('pay_saved'));
      expect(summary(calls)).toEqual([...SAVED_CARD_CAPTURE, 'GET /payments/pay_saved']);
    });

    it('fails, naming the Razorpay payment, when the capture fails and it is still not captured', async () => {
      const log = quietLog();
      fakeRazorpay([], { captures: { pay_saved: 'error' } });
      expect(await charge(request(renewal))).toEqual(failure('Saved card payment pay_saved was not finalized: Razorpay: Gateway timeout'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('fails, naming the Razorpay payment, when it can not be read after creation', async () => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { failGet: ['pay_saved'] });
      const result = await charge(request(renewal));
      expect(result).toEqual(failure('Saved card payment pay_saved was not finalized: Razorpay: Service unavailable'));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pay_saved'), expect.stringContaining('swell_pay_1'));
    });

    it('fails, naming the Razorpay payment, when it is neither authorized nor captured', async () => {
      const log = quietLog();
      const { calls } = fakeRazorpay([], { recurringStatus: 'failed' });
      expect(await charge(request(renewal))).toEqual(failure('Saved card payment pay_saved was not finalized: Payment is not authorized (status: failed)'));
      expect(summary(calls)).toEqual(SAVED_CARD_AUTHORIZE);
      expect(log).toHaveBeenCalledOnce();
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

    it('fails without a phone number, before calling Razorpay', async () => {
      const { calls } = fakeRazorpay([]);
      const shopper = { name: 'Ada', email: 'ada@example.com', billing: {}, shipping: {} };
      expect(await charge(request(renewal, shopper))).toEqual(failure('A phone number is required to charge the saved card'));
      expect(calls).toEqual([]);
    });

    it('fails without an email address, before calling Razorpay', async () => {
      const { calls } = fakeRazorpay([]);
      expect(await charge(request(renewal, { ...account, email: ' ' }))).toEqual(failure('An email address is required to charge the saved card'));
      expect(calls).toEqual([]);
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
