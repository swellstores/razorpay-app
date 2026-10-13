import { afterEach, describe, expect, it, vi } from 'vitest';

import Razorpay, { RazorpayError } from '../functions/lib/razorpay';

const razorpay = () => new Razorpay('rzp_test_1', 'secret');
const answer = (response: Response) => vi.stubGlobal('fetch', vi.fn(async () => response));

afterEach(() => vi.unstubAllGlobals());

describe('Razorpay client', () => {
  describe('createCustomer', () => {
    it('returns the customer', async () => {
      answer(Response.json({ id: 'cust_1', email: 'a@b.c' }));
      expect(await razorpay().createCustomer({ email: 'a@b.c' })).toMatchObject({ id: 'cust_1' });
    });

    it.each([
      ['no id', {}],
      ['an id that is not a string', { id: 1 }],
      ['an empty id', { id: '' }],
    ])('fails when the answer has %s', async (_name, body) => {
      answer(Response.json(body));
      await expect(razorpay().createCustomer({ email: 'a@b.c' })).rejects.toThrow('Razorpay did not return a customer');
    });
  });

  describe('request errors', () => {
    it.each([400, 404, 502, 503])('carry the HTTP status %i', async (status) => {
      answer(Response.json({ error: { description: 'Nope' } }, { status }));
      const error = await razorpay().getPayment('pay_1').catch((error) => error);
      expect(error).toBeInstanceOf(RazorpayError);
      expect(error).toMatchObject({ message: 'Razorpay: Nope', status });
    });

    it('pass a network failure through without a status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
      const error = await razorpay().getPayment('pay_1').catch((error) => error);
      expect(error).not.toBeInstanceOf(RazorpayError);
      expect(error.status).toBeUndefined();
    });
  });
});
