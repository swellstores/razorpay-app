/**
 * The phone sent to Razorpay as the customer's contact. Saving the card (create_intent) and charging it
 * must send the same one: `fail_existing: '0'` finds the existing customer by its details.
 */
export function contactOf(account: { phone?: string; billing?: { phone?: string }; shipping?: { phone?: string } }): string | undefined {
  return account.phone || account.billing?.phone || account.shipping?.phone || undefined;
}
