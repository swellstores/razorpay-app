# Razorpay

Razorpay app for Swell. It is the gateway behind Swell's native card payment method (`method: card`), for cards only.

## How it works

The card is saved, and every payment is finalized on the server:

1. **Tokenize.** The app creates a Razorpay customer from the Swell account (it needs an email address and a phone number) and an order with manual capture and a recurring token (`payment.create_intent`). The checkout component opens the Razorpay modal for it. The shopper authorizes the card, which Razorpay saves on the customer as a recurring token; after a failed attempt the modal stays open so the shopper can retry. The app verifies the payment signature (`payment.get_intent`) and the component saves the card token, its brand, last four digits and expiry, and the authorized payment id as billing.
2. **Finalize.** Swell calls `payment.charge` for the order, once to authorize and once to capture (or once, depending on the store's capture setting). The app captures the shopper's authorization if it is still valid and not owned by another Swell payment. Razorpay keeps an authorization for up to 5 days, so a merchant can capture later with automatic capture off. If there is no usable authorization (expired, released, taken by another payment, or no checkout at all as in a renewal or an admin charge), the app charges the saved card with a new recurring payment. That payment is created for authorization only and captured explicitly in the capture call. Its authorization is not the checkout's 5-day order: it expires on Razorpay's default window, so a capture after it has expired charges the saved card again with a new payment.

The browser chooses which Razorpay payment and card token the checkout saves, so the charge is the trusted check. Every existing Razorpay payment it uses must match the order: card method, amount and currency. A mismatching authorization is left alone and the saved card is charged instead. A mismatching payment that this Swell payment already captured fails the charge, without charging the card again. New saved card payments are created by the app for the order amount and currency. The charge binds a captured payment to its Swell payment with `notes.swell_payment_id`; a payment bound to another Swell payment is never used. An already captured payment that is not recorded is never charged again; the charge fails and the merchant must contact support.

Refunds go through `payment.refund`.

| Function | Purpose |
| --- | --- |
| `functions/card-intent-create.ts` | Creates the Razorpay customer and the order for the modal |
| `functions/card-intent-get.ts` | Verifies the modal's HMAC signature and loads the payment with its saved card |
| `functions/card-charge.ts` | Captures the authorization or charges the saved card |
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

For each order, the logs should show `payment.charge` calls whose `transaction_id` is the captured Razorpay payment, or the new recurring payment when the saved card was charged.

## Limits

- Cards only.
- Subscriptions are supported (`subscriptions: true` on the card extension): renewals charge the saved card token without a checkout. A card saved without recurring support cannot be charged later.
- Currencies follow Razorpay. Amounts are sent in the currency's smallest unit, and zero-decimal and three-decimal currencies are handled in `lib/amount.ts`.
