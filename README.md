# Razorpay for Swell

**Card payments in the Swell checkout with Razorpay, with saved cards and subscriptions.**

The app makes Razorpay the gateway of Swell's **Card** payment method. Shoppers pay in Razorpay's payment window inside the hosted checkout, and the card is saved with Razorpay. Every payment is then completed on the server: the shopper's authorization is captured when Swell asks for the capture, or the saved card is charged when there is no usable authorization (a subscription renewal, **Charge order**).

---

## Features

### Checkout

The **Card** method shows a short note in the checkout. On **Complete order** the Razorpay window opens; the shopper pays, and can retry a declined card in the same window. The card is saved on a Razorpay customer kept on the Swell account. The order is placed with the authorized payment and the saved card (token, brand, last four digits, expiry).

- **Where you see it:** the hosted checkout, when **Card** is selected.
- **Built with:** `components/Razorpay.tsx` (an `@swell/apps-sdk` component on the `card` extension and the `checkout.payment.methods` target), `payment.create_intent` (`card-intent-create`: customer and order) and `payment.get_intent` (`card-intent-get`: signature check, saved card).

### Capture

Swell calls the charge to authorize and to capture, following the store's capture settings. The app captures the shopper's authorization while it is valid (Razorpay keeps it for 5 days). Before taking any money it checks the amount, the currency and the card method against the order, and that no other Swell payment has used the authorization.

- **Where you see it:** the order's transactions.
- **Built with:** `payment.charge` (`card-charge`).

### Saved card charges

When there is no usable authorization, the saved card is charged with a new Razorpay payment: subscription renewals, **Charge order**, and an authorization that does not match the order. These charges take longer than Swell allows a payment hook, so the payment shows **Pending** and is completed a few seconds later by a workflow. A sweep every 30 minutes completes any that are left.

- **Where you see it:** the order's transactions (**Pending**, then **Paid**), and **Workflow runs** in the dashboard.
- **Built with:** `card-charge` (answers `async: true`), the workflow `card-charge-finish`, the cron `card-charge-sweep`.

### Refunds

Full and partial refunds from the order go back to the card through Razorpay.

- **Built with:** `payment.refund` (`card-refund`).

### Subscriptions

The card extension declares `subscriptions: true`, so **Card** is offered for subscription carts, and renewals charge the saved card.

---

## Setup

### What you need

- A Razorpay account with **recurring card payments** enabled, so that cards can be saved and charged again.
- Its API keys: **Account & Settings → API Keys** in the Razorpay Dashboard.

### Steps

1. **Install the app** from the Swell App Store.
2. In **Settings → Payments → Card**, choose **Razorpay** as the gateway.
3. Enter the keys (below) and press **Save**. The method is activated only on save.
4. Place a test order with test keys (`rzp_test_…`) before switching to live keys.

### Settings

| Setting | What it does |
|---|---|
| Key ID | Public key. Opens the Razorpay window in the checkout. |
| Key secret | Used only by the app's functions, never sent to the browser. |

The shopper needs an email address and a phone number: Razorpay requires both to save the card. The phone is taken from the account or the checkout address.

---

## Day-to-day use

- **Nothing to do for new orders.** Payments are taken according to the store's capture settings.
- **Capture later** from the order within 5 days. After that the authorization has expired: use **Charge order** to charge the saved card.
- **A payment shows Pending** while a saved card charge is completed, usually for a few seconds.

---

## Limits

- Cards only: Razorpay's other methods (UPI, netbanking, wallets) are not offered.
- A single charge on a saved card is limited to 10,000 in the order's currency.
- Razorpay decides which cards and currencies support recurring payments.
- In live mode, a charge on a saved Indian card is debited only after Razorpay notifies the cardholder, about 36 hours later. The payment stays **Pending** until then (the app checks every 6 hours, for up to 8 days).

---

## Development

**Requirements:** Node 22+, the Swell CLI logged in to the store you deploy to.

```bash
npm install
npm run typecheck
npm test                                 # Vitest
swell app push                           # deploy
swell logs --type function --app=.
swell logs --type workflow --app=.       # card-charge-finish steps
```

- Workflows run only after `swell app push`, not under `swell app dev`, so a saved card charge stays **Pending** there.
- `swell app push` exits successfully even when a file fails; read its output.
