# Razorpay

Razorpay app for Swell. It is the gateway behind Swell's native card payment method (`method: card`), for cards only.

## How it works

The card is saved, and every payment is finalized on the server:

1. **Tokenize.** The app creates a Razorpay customer from the Swell account's email address and phone (the phone typed into the checkout when the account has none yet) and keeps it on the account (`$app.razorpay.customer_id` and `contact`, `models/accounts.json`): later checkouts and every saved card charge use that customer, whatever the account's phone becomes. Then it creates an order with manual capture and a recurring token (`payment.create_intent`). The checkout component opens the Razorpay modal for it. The shopper authorizes the card, which Razorpay saves on the customer as a recurring token; after a failed attempt the modal stays open so the shopper can retry. The app verifies the payment signature (`payment.get_intent`) and the component saves the card token, its brand, last four digits and expiry, and the authorized payment id as billing.
2. **Finalize.** Swell calls `payment.charge` for the order, once to authorize and once to capture (or once, depending on the store's capture setting). The app captures the shopper's authorization if it is still valid and not owned by another Swell payment. Razorpay keeps an authorization for up to 5 days, so a merchant can capture later with automatic capture off. If there is no usable authorization (expired, released, taken by another payment, or no checkout at all as in a renewal or an admin charge), the app charges the saved card with a new recurring payment (see [Saved card charges](#saved-card-charges)). When the capture of an authorization fails but it is still authorized, the saved card is charged only if Razorpay refused the capture (a 4xx answer); after a network error or a 5xx the charge fails and the merchant retries it, rather than risk taking the money twice.

The browser chooses which Razorpay payment and card token the checkout saves, so the charge is the trusted check. Every existing Razorpay payment it uses must match the order: card method, amount and currency. A mismatching authorization is left alone and the saved card is charged instead. A mismatching payment that this Swell payment already captured fails the charge, without charging the card again. New saved card payments are created by the app for the order amount and currency. The charge binds a captured payment to its Swell payment with `notes.swell_payment_id`; a payment bound to another Swell payment is never used. An already captured payment that is not recorded is never charged again; the charge fails and the merchant must contact support.

### Saved card charges

Swell gives `payment.charge` 10 seconds, each Razorpay call takes about 2, and creating a recurring payment takes more than 6 because Razorpay authorizes the card with the network. So a new saved card payment is finished asynchronously:

1. In the charge, the lookup of an earlier attempt, the Razorpay order and the customer run in parallel. The order carries the Swell payment id as the receipt. If the lookup fails, the email address or phone is missing, or the order can not be created, the charge fails right away.
2. The charge answers `async: true`, without `success`, so the Swell payment stays pending.
3. In the background, the app creates the recurring payment. A valid order signature on the answer means it is authorized; without one the app reads it. When Swell asks for the capture, the app captures it explicitly: Razorpay leaves a recurring payment authorized whatever the order's `payment_capture` says, so orders are always created with `payment_capture: false`. Then it writes the result on the Swell payment: `success: true` with the Razorpay payment as `transaction_id` (and `captured: true` when it captured), or `success: false` with an error naming the Razorpay payment. This normally takes a few seconds.
4. When the outcome is unknown (an answer lost, a 5xx or no answer from the capture) or Razorpay still waits to debit the card (`created`, in live mode), the app writes nothing and the payment stays pending.

When Swell asks for authorization only, the capture call captures the payment later through its `transaction_id`. That authorization is not the checkout's 5-day order: it expires on Razorpay's default window, so a capture after it has expired charges the saved card again with a new payment.

A retry of the charge finds the payment of an earlier attempt by its order receipt and finishes it in the charge, instead of charging the card again. One still `created`, or a captured one that does not match the order, fails the charge.

**Sweep.** `functions/card-charge-sweep.ts` runs every 5 minutes. It picks up pending card payments (`async: true`, no `success`, not void) created between 2 minutes and 8 days ago, oldest first, 50 per run, and finds their Razorpay payment by order receipt. A Swell payment without a Razorpay order of its receipt is not this app's and is left alone. It finishes them by the charge's rules: a captured payment is recorded; an authorized one is captured first when the Swell payment asks for the capture, and only recorded when it is authorize only; a `created` one stays pending until Razorpay debits it; a captured one that does not match the order fails the Swell payment. An order still without a usable payment 30 minutes after it was created fails the Swell payment ("The saved card charge did not complete").

Refunds go through `payment.refund`.

| Function | Purpose |
| --- | --- |
| `functions/card-intent-create.ts` | Creates the Razorpay customer and the order for the modal |
| `functions/card-intent-get.ts` | Verifies the modal's HMAC signature and loads the payment with its saved card |
| `functions/card-charge.ts` | Captures the authorization or charges the saved card |
| `functions/card-charge-sweep.ts` | Finishes the saved card charges left pending, every 5 minutes |
| `functions/card-refund.ts` | Refunds a payment |

Settings are in `settings/card.json`:

- `key_id` is public and is used by the checkout component.
- `key_secret` is used only by functions.

The checkout component (`components/Razorpay.tsx`) renders in the hosted checkout's payment method body through `@swell/apps-sdk`, on the `card` extension and the `checkout.payment.methods` target.

## Merchant setup

1. Install the app.
2. In Swell, go to Settings → Payments → Card and choose Razorpay as the gateway.
3. Enter the Key ID and Key secret from the Razorpay Dashboard (Account & Settings → API Keys).
4. Click Save. The card extension only activates after you save.
5. In the Razorpay Dashboard, make sure the account can take recurring card payments (card tokenization with recurring charges). Without it the modal cannot save the card and server-side charges fail.

## Installing

`@swell/apps-sdk` 2.0.0-alpha.7 is not published to npm yet. Until it is, install it from the SDK tarball:

```sh
npm install
npm install --no-save <path to swell-apps-sdk-2.0.0-alpha.7.tgz>
```

`package-lock.json` does not list the SDK yet. It is regenerated after the SDK is published.

## Testing

Use Razorpay test keys, which start with `rzp_test_`. Use the Razorpay test card `4111 1111 1111 1111` with any future expiry date and any CVV.

```sh
npx vitest run      # unit tests
npm run typecheck   # TypeScript check
```

## Development

```sh
swell app push      # deploy the app to the store
swell app dev       # local development
swell logs --type function --app=.
```

For each order, the logs should show `payment.charge` calls whose `transaction_id` is the captured Razorpay payment. When the saved card is charged, the charge answers `async: true` and the Swell payment gets the new recurring payment as its `transaction_id` a few seconds later, or from the sweep. Background and sweep failures are logged with the Swell and Razorpay payment ids.

## Limits

- Cards only.
- Subscriptions are supported (`subscriptions: true` on the card extension): renewals charge the saved card token without a checkout. A card saved without recurring support cannot be charged later.
- Razorpay recurring card payments are INR-only per Razorpay, so the card can be saved and charged in INR only. Amounts are sent in the currency's smallest unit (`lib/amount.ts`).
- The saved token is capped at ₹10,000 per charge (`max_amount: 1000000`).
- In live mode Razorpay debits Indian recurring cards only after a pre-debit notification (about 36 hours). A saved card charge (a subscription renewal, a late capture after the authorization expired, an admin charge) stays pending until then, and the sweep finishes it once Razorpay debits the card, within its 8-day window. Test mode charges immediately.
