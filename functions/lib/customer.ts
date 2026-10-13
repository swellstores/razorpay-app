import type Razorpay from './razorpay';

interface Account {
  name?: string;
  email?: unknown;
  phone?: unknown;
  billing?: { phone?: unknown };
  shipping?: { phone?: unknown };
  $app?: Record<string, { customer_id?: unknown; contact?: unknown } | undefined>;
}

function trimmed(value: unknown): string | undefined {
  return (typeof value === 'string' && value.trim()) || undefined;
}

/** A phone from the browser: the vault turns a numeric query value such as `2198369784` into a number */
function phoneOf(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : trimmed(value);
}

/** The phone stored on the Swell account */
export function contactOf(account: Account): string | undefined {
  return trimmed(account.phone) || trimmed(account.billing?.phone) || trimmed(account.shipping?.phone);
}

/** The Razorpay customer and contact kept on the account when the card was first saved or charged */
function keptOf(req: SwellRequest, account: Account) {
  const kept = account.$app?.[req.appId];
  const id = trimmed(kept?.customer_id);
  const contact = trimmed(kept?.contact);
  return id && contact ? { id, contact } : undefined;
}

/**
 * The Razorpay customer of a Swell account, where the card is saved and where it is charged. The first
 * one is kept on the account, so every later checkout and charge uses the customer the card tokens
 * belong to, whatever the account's phone becomes. Without one, the contact is the account's phone, else
 * `fallbackContact` (the phone typed into the checkout: an account often has none before its first
 * order). `purpose` ends the messages for missing details.
 */
export async function customerOf(
  req: SwellRequest,
  razorpay: Razorpay,
  accountId: string,
  purpose: 'save the card' | 'charge the saved card',
  fallbackContact?: unknown,
): Promise<{ id: string; email: string; contact: string }> {
  const account: Account = (await req.swell.get(`/accounts/${accountId}`)) ?? {};
  const email = trimmed(account.email);
  if (!email) {
    throw new Error(`An email address is required to ${purpose}`);
  }
  const kept = keptOf(req, account);
  if (kept) {
    return { ...kept, email };
  }
  const contact = contactOf(account) || phoneOf(fallbackContact);
  if (!contact) {
    throw new Error(`A phone number is required to ${purpose}`);
  }
  // Returns the existing customer when the same details were saved before
  const customer = await razorpay.createCustomer({ name: account.name, email, contact, fail_existing: '0' });
  await req.swell.put(`/accounts/${accountId}`, req.appValues({ customer_id: customer.id, contact }));
  return { id: customer.id, email, contact };
}
