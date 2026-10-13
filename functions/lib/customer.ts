import type Razorpay from './razorpay';

interface Account {
  name?: string;
  email?: unknown;
  phone?: unknown;
  billing?: { phone?: unknown };
  shipping?: { phone?: unknown };
}

function trimmed(value: unknown): string | undefined {
  return (typeof value === 'string' && value.trim()) || undefined;
}

/**
 * The phone sent to Razorpay as the customer's contact. Saving the card (create_intent) and charging it
 * must send the same one: `fail_existing: '0'` finds the existing customer by its details.
 */
export function contactOf(account: Account): string | undefined {
  return trimmed(account.phone) || trimmed(account.billing?.phone) || trimmed(account.shipping?.phone);
}

/**
 * The Razorpay customer of a Swell account, loaded the same way where the card is saved and where it is
 * charged, so both find the same customer. `purpose` ends the messages for missing details.
 */
export async function customerOf(
  req: SwellRequest,
  razorpay: Razorpay,
  accountId: string,
  purpose: 'save the card' | 'charge the saved card',
): Promise<{ id: string; email: string; contact: string }> {
  const account: Account = (await req.swell.get(`/accounts/${accountId}`)) ?? {};
  const email = trimmed(account.email);
  if (!email) {
    throw new Error(`An email address is required to ${purpose}`);
  }
  const contact = contactOf(account);
  if (!contact) {
    throw new Error(`A phone number is required to ${purpose}`);
  }
  // Returns the existing customer when the same details were saved before
  const customer = await razorpay.createCustomer({ name: account.name, email, contact, fail_existing: '0' });
  return { id: customer.id, email, contact };
}
