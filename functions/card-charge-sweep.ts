import type Razorpay from './lib/razorpay';
import { chargeOf, findSavedPayment, finishSavedPayment, messageOf, mismatchOf, notFinalized, recordOutcome } from './lib/saved-charge';
import { getRazorpay } from './lib/settings';

export const config: SwellConfig = {
  description: 'Finish the saved card charges whose workflow failed or was stopped',
  cron: { schedule: '*/30 * * * *' },
};

const MINUTE = 60 * 1000;
/** The card-charge-finish workflow finishes a charge; the sweep only takes those it left after 30 minutes */
const SETTLED_AFTER = 30 * MINUTE;
/** An order of the charge still without a Razorpay payment never gets one */
const ABANDONED_AFTER = 30 * MINUTE;
/** Live recurring debits wait about 36 hours for the pre-debit notification; older charges are left alone */
const WINDOW = 8 * 24 * 60 * MINUTE;
/** Each payment takes 1 to 3 Razorpay calls of about 2 seconds, and the cron gets 10 seconds */
const BATCH = 10;
const CONCURRENCY = 5;
const BUDGET = 6000;

/** A Swell payment the charge left pending (`async`) */
type PendingPayment = {
  id: string;
  amount?: number;
  currency?: string;
  captured?: boolean;
  date_created?: string;
};

type PaymentMethod = { id?: string; extension_app_id?: string; extension_config_id?: string };

/**
 * The gateway the platform stamps on this app's card payments, `app_<app id>_<config id>`, from the card
 * method's settings. Undefined when the card method is not an app's.
 */
async function gatewayOf(req: SwellRequest): Promise<string | undefined> {
  const settings = await req.swell.get('/settings/payments');
  const methods: PaymentMethod[] = Array.isArray(settings?.methods) ? settings.methods : [];
  const card = methods.find((method) => method?.id === 'card');
  if (!card?.extension_app_id) return undefined;
  return `app_${card.extension_app_id}_${card.extension_config_id || 'card'}`;
}

/**
 * Finishes one pending Swell payment by the rules of the charge, from the saved card payment found by its
 * order receipt. Without an order of that receipt it is not this app's charge. An order without a payment
 * fails only once it is 30 minutes old: the newest order is the latest attempt, so an old Swell payment
 * charged again just now is not failed under its workflow.
 */
async function sweepPayment(req: SwellRequest, razorpay: Razorpay, pending: PendingPayment, now: number) {
  const charge = chargeOf(razorpay, pending);
  const { orders, payment } = await findSavedPayment(charge);
  if (!payment) {
    const startedAt = Math.max(Date.parse(pending.date_created ?? '') || 0, ...orders.map((order) => (order.created_at ?? 0) * 1000));
    if (orders.length > 0 && now - startedAt > ABANDONED_AFTER) {
      await recordOutcome(req.swell, charge, { reason: 'The saved card charge did not complete' });
    }
    return;
  }
  // A captured one that does not match the order took the money: it fails rather than charge again
  const mismatch = payment.status === 'captured' && mismatchOf(payment, charge);
  if (mismatch) {
    await recordOutcome(req.swell, charge, { reason: notFinalized(payment.id, mismatch) }, payment.id);
    return;
  }
  // The list's status is as fresh as a read; a `created` one waits for the pre-debit notification
  await finishSavedPayment(req.swell, charge, payment.id, payment.status);
}

export default async function (req: SwellRequest) {
  const now = Date.now();
  const gateway = await gatewayOf(req);
  if (!gateway) {
    console.error('Saved card charge sweep skipped: the card payment method is not an app\'s');
    return;
  }
  const { results = [] }: { results?: PendingPayment[] } =
    (await req.swell.get('/payments', {
      where: {
        async: true,
        // Not `success: null`: the query string sends it as the text "null", which matches nothing
        status: 'pending',
        method: 'card',
        gateway,
        void: { $ne: true },
        date_created: { $lt: new Date(now - SETTLED_AFTER).toISOString(), $gt: new Date(now - WINDOW).toISOString() },
      },
      // Newest first: a live debit waiting for days does not hold back the charges that just lost an answer
      sort: 'date_created desc',
      limit: BATCH,
    })) ?? {};
  if (results.length === 0) return;

  const razorpay = await getRazorpay(req);
  // A few at a time, none started once the budget is spent (a later run takes them), and one payment's
  // error does not stop the others
  const queue = [...results];
  const worker = async () => {
    for (let pending = queue.shift(); pending && Date.now() - now < BUDGET; pending = queue.shift()) {
      try {
        await sweepPayment(req, razorpay, pending, now);
      } catch (error) {
        console.error(`Could not sweep the saved card charge: ${messageOf(error)}`, `(Swell payment ${pending.id})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
