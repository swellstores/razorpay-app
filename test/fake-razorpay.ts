import { vi } from 'vitest';
import { createHmac } from 'node:crypto';

export const API = 'https://api.razorpay.com/v1';
export const settings = { key_id: 'rzp_test_1', key_secret: 'secret' };

export type Call = { method: string; url: string; body?: any };
type CaptureMode = 'taken' | 'lost' | 'refused' | 'error' | 'throttled' | 'offline' | 'expired';

export const summary = (calls: Call[]) => calls.map(({ method, url }) => `${method} ${url.slice(API.length)}`);

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
 * `loseRecurring` loses the first create/recurring answer after creating the payment; `refuseRecurring`
 * refuses it (4xx) without creating one; `recurringDown` fails it (5xx) without creating one; `recurringNoId` creates it but answers without its id; create/recurring answers only once `recurringGate` resolves.
 * `failOrder` fails POST /orders. GET of an id in `failGet` answers with an error; `failLookup` fails the orders or order payments list.
 */
export function fakeRazorpay(
  payments: Record<string, unknown>[],
  {
    orders = [], captures = {}, recurringStatus = 'authorized', recurringNotes = true, recurringSignature = true, loseRecurring = false,
    refuseRecurring = false, recurringDown = false, recurringNoId = false, recurringGate, failOrder = false, receiptFilter = true, failGet = [], failLookup, patch,
  }: {
    orders?: Record<string, unknown>[];
    captures?: Record<string, CaptureMode>;
    recurringStatus?: string;
    recurringNotes?: boolean;
    recurringSignature?: boolean;
    loseRecurring?: boolean;
    refuseRecurring?: boolean;
    recurringDown?: boolean;
    recurringNoId?: boolean;
    recurringGate?: Promise<unknown>;
    failOrder?: boolean;
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
      if (failOrder) return fail(503, 'Service unavailable');
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
      await recurringGate;
      if (refuseRecurring) return fail(400, 'The token is invalid');
      if (recurringDown) return fail(503, 'Service unavailable');
      const notes = recurringNotes ? body.notes : [];
      // Razorpay answers `authorized` and does not capture it, whatever the order's `payment_capture`
      store.set('pay_saved', { id: 'pay_saved', status: recurringStatus, amount: body.amount, currency: body.currency, method: 'card', order_id: body.order_id, notes });
      if (lose) {
        lose = false;
        return fail(504, 'Gateway timeout');
      }
      // Seen in e2e: Razorpay authorized the card debit but answered without the payment id
      if (recurringNoId) return Response.json({ razorpay_order_id: body.order_id });
      // Razorpay signs a successful payment with the order, as the checkout modal does
      const signed = recurringSignature && ['authorized', 'captured'].includes(recurringStatus);
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
  return {
    calls,
    payment: (id: string) => store.get(id),
    order: (id: string) => orderStore.get(id),
    /** Changes a payment, as Razorpay does on its own (a live debit) */
    update: (id: string, changes: Record<string, unknown>) => store.set(id, { ...store.get(id)!, ...changes }),
  };
}
