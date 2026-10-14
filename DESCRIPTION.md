# Razorpay for Swell

Accept card payments in your Swell checkout with Razorpay. Shoppers pay in Razorpay's secure window, their card is saved for later charges, and every payment is completed from your store, so you decide when the money is taken.

## Card payments in your checkout

- Razorpay becomes the gateway of your store's **Card** payment method.
- Shoppers pay in Razorpay's secure payment window, without leaving the checkout. If a card is declined, they can try again in the same window.
- Card details never touch your store: Swell keeps only Razorpay's token for the card, its brand, the last four digits and the expiry date.

## You decide when to take the money

- With automatic capture on, the payment is taken as soon as the order is placed.
- With it off, the card is only authorized. Capture the payment from the order, when you ship or whenever you choose, within 5 days.
- If the authorization has expired or was released by then, use **Charge order** to charge the shopper's saved card instead.

## Saved cards and subscriptions

- The shopper's card is saved with Razorpay at checkout.
- **Subscriptions** renew on the saved card automatically.
- **Charge order** in your dashboard charges the saved card, for example for an order edited after it was placed.

## Refunds from your dashboard

Refund a payment, fully or in part, from the order in Swell. The refund goes back to the shopper's card through Razorpay.

## Safe by design

- Every payment is checked against the order before it is taken: the amount, the currency and the card method.
- A payment is never taken twice, even when a request is retried or two charges race.
- Charges on a saved card can take a few seconds. Their payment shows as pending in the order until Razorpay confirms it.

## Set up in minutes

1. Install the app.
2. In **Settings → Payments → Card**, choose **Razorpay** as the gateway.
3. Paste your **Key ID** and **Key secret** from the Razorpay Dashboard (**Account & Settings → API Keys**) and press **Save**.

Your Razorpay account needs recurring card payments enabled, so that cards can be saved and charged again.

## Good to know

- Cards only. Other Razorpay methods (UPI, netbanking, wallets) are not offered.
- A single charge on a saved card is limited to 10,000 in the order's currency.
- On Razorpay's live mode, a charge on a saved Indian card is taken only after Razorpay notifies the cardholder, about 36 hours later. Until then the payment shows as pending in the order.
