import Razorpay, { type RazorpayPayment } from './lib/razorpay';
import {
  captureSavedPayment,
  type Charge,
  type FinishParams,
  findSavedPayment,
  isRefusal,
  messageOf,
  mismatchOf,
  notFinalized,
  type Outcome,
  logError,
  readSwellPayment,
  recordOutcome,
  type SwellPayment,
  type SwellTarget,
  wantsCapture,
  writePayment,
} from './lib/saved-charge';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Charge the saved card for a pending Swell payment, capture it when asked, and record the result',
};

/** Swell calls and reads are safe to repeat; a capture of a captured payment answers 400, then reads captured */
const RETRIES: SwellWorkflowStepOptions = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } };
/** Capturing an authorized payment is idempotent, and a late capture has no other taker: try longer */
const LATE_CAPTURE_RETRIES: SwellWorkflowStepOptions = { retries: { limit: 6, delay: '10 seconds', backoff: 'exponential' } };
/** A lost answer may have charged the card: create/recurring is never retried */
const NO_RETRIES: SwellWorkflowStepOptions = { retries: { limit: 0, delay: '1 second' } };
/** Live recurring debits wait about 36 hours for the pre-debit notification: read every 6 hours for 8 days */
const DEBIT_WAIT = '6 hours';
const DEBIT_WAITS = 32;

type Status = RazorpayPayment['status'];
/** What creating (or finding) the payment gave: the payment, Razorpay's refusal, or nothing found */
type Created = { paymentId: string; status?: Status; mismatch?: string } | { refused: string } | { missing: true };

function createdOf(payment: RazorpayPayment, charge: Charge): Created {
  const mismatch = payment.status === 'captured' ? mismatchOf(payment, charge) : undefined;
  return { paymentId: payment.id, status: payment.status, ...(mismatch && { mismatch }) };
}

/**
 * A payment on the hook's order that holds or will take the money: only this run creates payments on
 * it, so one there is this run's own, from an attempt the engine restarted
 */
async function paymentOnOrder(charge: Charge, orderId: string): Promise<Created | undefined> {
  const payments = await charge.razorpay.getOrderPayments(orderId);
  const payment =
    payments.find(({ status }) => status === 'created' || status === 'captured') ??
    payments.find((payment) => payment.status === 'authorized' && !mismatchOf(payment, charge));
  return payment && createdOf(payment, charge);
}

/**
 * Creates the recurring payment on the hook's order, at most once: the engine may run the step again
 * after a restart, so a payment already on the order is taken instead. A valid order signature means it
 * is authorized. Razorpay's refusal is an answer, so the step returns it, unless the order has a payment
 * after all (a repeated create refused while the first one holds the money); anything else leaves the
 * outcome unknown and fails the step, whose error loses its class.
 */
async function createPayment(charge: Charge, params: FinishParams): Promise<Created> {
  const { razorpay } = charge;
  const existing = await paymentOnOrder(charge, params.razorpay_order_id);
  if (existing) return existing;
  try {
    const answer = await razorpay.createRecurringPayment({
      email: params.customer.email,
      contact: params.customer.contact,
      amount: params.amount,
      currency: params.currency,
      order_id: params.razorpay_order_id,
      customer_id: params.customer.id,
      token: params.token,
      recurring: '1',
      notes: { swell_payment_id: params.swell_payment_id },
    });
    const paymentId = answer.razorpay_payment_id;
    if (typeof paymentId !== 'string' || !paymentId) {
      // Razorpay may answer a card debit without the payment id while it still authorizes it: the order holds
      // only this payment, so take it from there. The keys (never values) of the answer help support.
      const found = await paymentOnOrder(charge, params.razorpay_order_id);
      if (found) return found;
      throw new Error(`Razorpay did not return a payment (answer: ${Object.keys(answer ?? {}).join(', ') || 'empty'})`);
    }
    const signed = await razorpay.verifySignature(params.razorpay_order_id, paymentId, answer.razorpay_signature ?? '');
    return signed ? { paymentId, status: 'authorized' } : { paymentId };
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return (await paymentOnOrder(charge, params.razorpay_order_id)) ?? { refused: messageOf(error) };
  }
}

/** The payment of this Swell payment found by its order receipt, after create/recurring lost its answer */
async function findCreated(charge: Charge): Promise<Created> {
  const { payment } = await findSavedPayment(charge);
  return payment ? createdOf(payment, charge) : { missing: true };
}

/** A Swell payment that failed or was voided while the run waited: its authorization releases on its own */
function abandoned(payment: SwellPayment): boolean {
  return payment.success === false || payment.void === true;
}

/**
 * Finishes a saved card charge the `payment.charge` hook left pending (`async`): the hook gives the whole
 * charge 10 seconds, and create/recurring alone takes more than 6. Each step is durable: the engine keys
 * it by its name and a per-name counter, and a step it recorded is not run again when it replays the run.
 * The capture is read from the Swell payment as stored, not from the hook's snapshot: an authorize-phase
 * charge may be captured while this runs.
 */
export default class CardChargeFinish {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const params = req.data as FinishParams;
    const target: SwellTarget = { swellPaymentId: params.swell_payment_id };

    /**
     * Runs `fn` with a Razorpay client built from the app's settings, read inside the step so the read is
     * retried with it. The keys stay in the step: never return them.
     */
    const withRazorpay = async <T>(fn: (charge: Charge) => Promise<T>): Promise<T> => {
      const settings = (await req.swell.get(`/settings/${req.appId}/card`)) as { key_id?: string; key_secret?: string } | null;
      const razorpay = new Razorpay(settings?.key_id ?? '', settings?.key_secret ?? '');
      return fn({ razorpay, swellPaymentId: params.swell_payment_id, amount: params.amount, currency: params.currency, capture: true });
    };

    /**
     * Writes the outcome, unless the Swell payment already has one (the sweep finished it meanwhile) or was
     * voided. Before a success it captures when the Swell payment asks for it now and nothing was captured.
     */
    const record = (outcome: Outcome, paymentId?: string, captured = false) =>
      step.do('record', RETRIES, async () => {
        const stored = await readSwellPayment(req.swell, target);
        const success = 'transactionId' in outcome;
        if (stored.success != null || stored.void === true) {
          if (success) {
            logError(`Saved card payment ${paymentId} not recorded: the Swell payment already has a result or was voided`, target, paymentId);
          }
          return { written: false, captured };
        }
        let capturedNow = captured;
        if (success && paymentId && !captured && stored.captured !== false) {
          await withRazorpay((charge) => captureSavedPayment(charge, paymentId));
          capturedNow = true;
        }
        await recordOutcome(req.swell, { ...target, capture: capturedNow }, outcome, paymentId);
        return { written: true, captured: capturedNow };
      });

    // A Swell payment that already has its result (the sweep failed it after 30 minutes without a payment)
    // or was voided gets no payment
    const pending = await step.do('check pending', RETRIES, async () => {
      const stored = await readSwellPayment(req.swell, target);
      return stored.success == null && stored.void !== true;
    });
    if (!pending) return false;

    // 1. Create the payment, at most once.
    //    Do not rename this step or the others: the step cache is keyed by name, and runs can sleep for 8 days
    let created: Created;
    try {
      created = await step.do('charge saved card', NO_RETRIES, () => withRazorpay((charge) => createPayment(charge, params)));
    } catch {
      // The payment may exist: give Razorpay a minute, then look for it by the order receipt
      await step.sleep('wait for Razorpay', '1 minute');
      created = await step.do('find by receipt', RETRIES, () => withRazorpay(findCreated));
    }
    if ('refused' in created) return (await record({ reason: created.refused })).written;
    if ('missing' in created) return (await record({ reason: 'The saved card charge did not complete' })).written;
    const { paymentId } = created;
    if (created.mismatch) return (await record({ reason: notFinalized(paymentId, created.mismatch) }, paymentId)).written;

    // 2. Its status; one still `created` waits for the live debit
    let status = created.status;
    let reads = 0;
    let waits = 0;
    for (;;) {
      if (status === 'created') {
        if (waits === DEBIT_WAITS) {
          const reason = notFinalized(paymentId, 'Payment is still pending (status: created) after 8 days');
          return (await record({ reason }, paymentId)).written;
        }
        waits += 1;
        await step.sleep(`wait for debit ${waits}`, DEBIT_WAIT);
        status = undefined;
      }
      if (status) break;
      reads += 1;
      status = await step.do(reads === 1 ? 'read payment' : `read payment ${reads}`, RETRIES, () =>
        withRazorpay(async ({ razorpay }) => (await razorpay.getPayment(paymentId)).status),
      );
    }
    if (status !== 'authorized' && status !== 'captured') {
      return (await record({ reason: notFinalized(paymentId, `Payment is not authorized (status: ${status})`) }, paymentId)).written;
    }
    const authorizedOnly = status === 'authorized';

    // 3. Capture when the Swell payment asks for it now; not for one that failed or was voided meanwhile
    const capture = await step.do('capture', RETRIES, async (): Promise<'captured' | 'authorized' | 'abandoned'> => {
      const stored = await readSwellPayment(req.swell, target);
      if (abandoned(stored)) {
        logError(`Saved card payment ${paymentId} left uncaptured: the Swell payment failed or was voided`, target, paymentId);
        return 'abandoned';
      }
      if (stored.captured === false) return 'authorized';
      if (authorizedOnly) await withRazorpay((charge) => captureSavedPayment(charge, paymentId));
      return 'captured';
    });
    if (capture === 'abandoned') return false;

    // 4. Record it
    const { written, captured } = await record({ transactionId: paymentId }, paymentId, capture === 'captured');

    // 5. A capture that came while this ran met the hook's in-flight guard, which left it here: once the
    //    authorize-only write is in, the Swell payment shows it
    if (written && !captured) {
      try {
        await step.do('late capture', LATE_CAPTURE_RETRIES, async () => {
          if (!(await wantsCapture(req.swell, target))) return false;
          await withRazorpay((charge) => captureSavedPayment(charge, paymentId));
          await writePayment(req.swell, target, { captured: true });
          return true;
        });
      } catch (error) {
        // The success is recorded and can not change: support captures or voids it
        logError(`Saved card payment ${paymentId} late capture failed: ${messageOf(error)}`, target, paymentId);
      }
    }
    return written;
  }
}
