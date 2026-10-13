# Razorpay

Razorpay app for Swell. It is the gateway behind Swell's native card payment method (`method: card`), for cards only.

## How it works

Payments are two-phase:

1. **Authorize.** The checkout component opens the Razorpay modal. Razorpay creates an order with manual capture (2 hour expiry), and the shopper authorizes the card in the modal. The app verifies the payment signature.
2. **Capture.** Swell calls `payment.charge` twice for the order. The first call (`captured: false`) checks that the payment is authorized and its amount matches the order. The second call (`captured: true`) captures it.

Refunds go through `payment.refund`.

| Function | Purpose |
| --- | --- |
| `functions/card-intent-create.ts` | Creates the Razorpay order for the modal |
| `functions/card-intent-get.ts` | Verifies the modal's HMAC signature and loads the payment |
| `functions/card-charge.ts` | Checks the authorization, then captures it |
| `functions/card-refund.ts` | Refunds a payment |

Settings are in `settings/card.json`:

- `key_id` is public and is used by the checkout component.
- `key_secret` is used only by functions.

The checkout component (`components/Razorpay.tsx`, added in a later change) renders in the hosted checkout's payment method body through `@swell/apps-sdk`, on the `card` extension and the `checkout.payment.methods` target.

## Merchant setup

1. Install the app.
2. In Swell, go to Settings → Payments → Card and choose Razorpay as the gateway.
3. Enter the Key ID and Key secret from the Razorpay Dashboard (Account & Settings → API Keys).
4. Click Save. The card extension only activates after you save.

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

For each order, the logs should show two `payment.charge` calls with the same `transaction_id`: one for the authorization check and one for the capture.

## Limits

- Cards only.
- No subscriptions and no saved cards. These would need Razorpay recurring tokens.
- Currencies follow Razorpay. Amounts are sent in the currency's smallest unit, and zero-decimal and three-decimal currencies are handled in `lib/amount.ts`.
