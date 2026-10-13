import type Razorpay from './lib/razorpay';
import {
  chargeOf,
  findSavedPayment,
  messageOf,
  mismatchOf,
  notFinalized,
  recordOutcome,
  settleSavedPayment,
} from './lib/saved-charge';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  description: 'Finish the saved card charges left pending: lost answers and live recurring debits',
  cron: { schedule: '*/5 * * * *' },
};

const MINUTE = 60 * 1000;
/** The charge's background work has had its time */
const SETTLED_AFTER = 2 * MINUTE;
/** An order of the charge still without a Razorpay payment never gets one */
const ABANDONED_AFTER = 30 * MINUTE;
/** Live recurring debits wait about 36 hours for the pre-debit notification; older charges are left alone */
const WINDOW = 8 * 24 * 60 * MINUTE;

/** A Swell payment the charge left pending (`async`) */
type PendingPayment = {
  id: string;
  amount?: number;
  currency?: string;
  captured?: boolean;
  date_created?: string;
};

/**
 * Finishes one pending Swell payment by the rules of the charge, from the saved card payment found by its
 * order receipt. Without an order of that receipt it is not this app's charge. An order without a payment
 * fails only once it is 30 minutes old: the newest order is the latest attempt, so an old Swell payment
 * charged again just now is not failed under the charge's background work.
 */
async function sweepPayment(req: SwellRequest, razorpay: Razorpay, pending: PendingPayment, now: number) {
  const charge = chargeOf(razorpay, pending);
  const { orders, payment } = await findSavedPayment(charge);
  if (!payment) {
    const startedAt = Math.max(Date.parse(pending.date_created ?? '') || 0, ...orders.map((order) => (order.created_at ?? 0) * 1000));
    if (orders.length > 0 && now - startedAt > ABANDONED_AFTER) {
      await recordOutcome(req, charge, { reason: 'The saved card charge did not complete' });
    }
    return;
  }
  // A captured one that does not match the order took the money: it fails rather than charge again
  const mismatch = payment.status === 'captured' && mismatchOf(payment, charge);
  // The list's status is as fresh as a read
  const outcome = mismatch ? { reason: mismatch } : await settleSavedPayment(payment.id, charge, payment.status);
  // Still `created`: Razorpay waits for the pre-debit notification, and a later sweep finishes it
  if (outcome === 'pending') return;
  const recorded = 'reason' in outcome ? { reason: notFinalized(payment.id, outcome.reason) } : outcome;
  await recordOutcome(req, charge, recorded, payment.id);
}

export default async function (req: SwellRequest) {
  const now = Date.now();
  const { results = [] }: { results?: PendingPayment[] } =
    (await req.swell.get('/payments', {
      where: {
        async: true,
        success: null,
        method: 'card',
        void: { $ne: true },
        date_created: { $lt: new Date(now - SETTLED_AFTER).toISOString(), $gt: new Date(now - WINDOW).toISOString() },
      },
      sort: 'date_created asc',
      limit: 50,
    })) ?? {};
  if (results.length === 0) return;

  const razorpay = await getRazorpay(req);
  // In parallel, and one payment's error does not stop the others
  const swept = await Promise.allSettled(results.map((pending) => sweepPayment(req, razorpay, pending, now)));
  swept.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Could not sweep the saved card charge: ${messageOf(result.reason)}`, `(Swell payment ${results[index].id})`);
    }
  });
}
