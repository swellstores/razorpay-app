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
  readSwellPayment,
  recordOutcome,
  wantsCapture,
  writePayment,
} from './lib/saved-charge';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Charge the saved card for a pending Swell payment, capture it when asked, and record the result',
};

/** Swell calls and reads are safe to repeat; a capture of a captured payment answers 400, then reads captured */
const RETRIES: SwellWorkflowStepOptions = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } };
/** A lost answer may have charged the card: create/recurring never runs twice */
const NO_RETRIES: SwellWorkflowStepOptions = { retries: { limit: 0, delay: '1 second' } };
/** Live recurring debits wait about 36 hours for the pre-debit notification: read every 6 hours for 8 days */
const DEBIT_WAIT = '6 hours';
const DEBIT_WAITS = 32;

type Status = RazorpayPayment['status'];
/** What creating (or finding) the payment gave: the payment, Razorpay's refusal, or nothing found */
type Created = { paymentId: string; status?: Status; mismatch?: string } | { refused: string } | { missing: true };

/**
 * Creates the recurring payment on the hook's order. A valid order signature means it is authorized.
 * Razorpay's refusal is an answer, so the step returns it; anything else leaves the outcome unknown and
 * fails the step, whose error loses its class.
 */
async function createPayment(razorpay: Razorpay, params: FinishParams): Promise<Created> {
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
    if (typeof paymentId !== 'string' || !paymentId) throw new Error('Razorpay did not return a payment');
    const signed = await razorpay.verifySignature(params.razorpay_order_id, paymentId, answer.razorpay_signature ?? '');
    return signed ? { paymentId, status: 'authorized' } : { paymentId };
  } catch (error) {
    if (isRefusal(error)) return { refused: messageOf(error) };
    throw error;
  }
}

/** The payment of this Swell payment found by its order receipt, after create/recurring lost its answer */
async function findCreated(charge: Charge): Promise<Created> {
  const { payment } = await findSavedPayment(charge);
  if (!payment) return { missing: true };
  const mismatch = payment.status === 'captured' ? mismatchOf(payment, charge) : undefined;
  return { paymentId: payment.id, status: payment.status, ...(mismatch && { mismatch }) };
}

/**
 * Finishes a saved card charge the `payment.charge` hook left pending (`async`): the hook gives the whole
 * charge 10 seconds, and create/recurring alone takes more than 6. Each step is durable, so a step that
 * completed is not run again on a retry. The capture is read from the Swell payment as stored, not from
 * the hook's snapshot: an authorize-phase charge may be captured while this runs.
 */
export default class CardChargeFinish {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const params = req.data as FinishParams;
    // Read on every run rather than in a step, so the keys are never kept in the run's state
    const settings = (await req.swell.get(`/settings/${req.appId}/card`)) as { key_id?: string; key_secret?: string } | null;
    const razorpay = new Razorpay(settings?.key_id ?? '', settings?.key_secret ?? '');
    const charge: Charge = {
      razorpay,
      swellPaymentId: params.swell_payment_id,
      amount: params.amount,
      currency: params.currency,
      capture: true,
    };

    /** Writes the outcome, unless the Swell payment already has one (the sweep finished it meanwhile) */
    const record = (outcome: Outcome, paymentId?: string, captured = false) =>
      step.do('record', RETRIES, async () => {
        if ((await readSwellPayment(req.swell, charge)).success != null) return false;
        await recordOutcome(req.swell, { ...charge, capture: captured }, outcome, paymentId);
        return true;
      });

    // 1. Create the payment, once
    let created: Created;
    try {
      created = await step.do('charge saved card', NO_RETRIES, () => createPayment(razorpay, params));
    } catch {
      // The payment may exist: give Razorpay a minute, then look for it by the order receipt
      await step.sleep('wait for Razorpay', '1 minute');
      created = await step.do('find by receipt', RETRIES, () => findCreated(charge));
    }
    if ('refused' in created) return record({ reason: created.refused });
    if ('missing' in created) return record({ reason: 'The saved card charge did not complete' });
    const { paymentId } = created;
    if (created.mismatch) return record({ reason: notFinalized(paymentId, created.mismatch) }, paymentId);

    // 2. Its status; one still `created` waits for the live debit
    let status = created.status;
    let reads = 0;
    let waits = 0;
    for (;;) {
      if (status === 'created') {
        if (waits === DEBIT_WAITS) {
          return record({ reason: notFinalized(paymentId, 'Payment is still pending (status: created) after 8 days') }, paymentId);
        }
        waits += 1;
        await step.sleep(`wait for debit ${waits}`, DEBIT_WAIT);
        status = undefined;
      }
      if (status) break;
      reads += 1;
      status = await step.do(reads === 1 ? 'read payment' : `read payment ${reads}`, RETRIES, async () => (await razorpay.getPayment(paymentId)).status);
    }
    if (status !== 'authorized' && status !== 'captured') {
      return record({ reason: notFinalized(paymentId, `Payment is not authorized (status: ${status})`) }, paymentId);
    }
    const authorizedOnly = status === 'authorized';

    // 3. Capture when the Swell payment asks for it now
    const captured = await step.do('capture', RETRIES, async () => {
      if (!(await wantsCapture(req.swell, charge))) return false;
      if (authorizedOnly) await captureSavedPayment(charge, paymentId);
      return true;
    });

    // 4. Record it
    const written = await record({ transactionId: paymentId }, paymentId, captured);

    // 5. A capture that came while this ran met the hook's in-flight guard, which left it here: once the
    //    authorize-only write is in, the Swell payment shows it
    if (written && !captured) {
      await step.do('late capture', RETRIES, async () => {
        if (!(await wantsCapture(req.swell, charge))) return false;
        await captureSavedPayment(charge, paymentId);
        await writePayment(req.swell, charge, { captured: true });
        return true;
      });
    }
    return written;
  }
}
