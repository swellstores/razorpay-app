Accept card payments in your Swell checkout with Razorpay. Shoppers pay in Razorpay's secure window without leaving the checkout, and Razorpay saves their card for subscription renewals and later charges.

Every payment is completed from your store: captured when the order is placed or later from the order, checked against the order before any money is taken, and refunded from the order in Swell.

- **Cards in your checkout.** Razorpay becomes the payment gateway for credit cards. Shoppers can retry a declined card in the same window, and Swell keeps only Razorpay's token for the card, with its brand, last four digits and expiry date.
- **Capture now or later.** Payments are captured when the order is placed. Turn off Charge automatically in your order settings to only authorize them, and capture from the order within 5 days.
- **Saved cards you can charge again.** Charge order charges the shopper's saved card, for example after the authorization expired or for a different amount. The payment shows as pending for a few seconds while Razorpay charges the card.
- **Subscriptions that renew on their own.** Renewals are charged on the saved card automatically, with no checkout for the customer.
- **Refunds from the order.** Refund a payment in full or in part, back to the shopper's card through Razorpay.
- **Never charged twice.** Each payment is checked for the order's amount, currency and card method, and a retried charge finishes the earlier Razorpay payment instead of taking the money again.

Setup takes a few minutes. In the Razorpay Dashboard, copy your Key ID and Key secret from Account & Settings > API Keys, and make sure recurring card payments are enabled. In Swell, go to Settings > Payments, click Edit settings under Credit cards, choose Razorpay as the payment gateway, paste the keys and save. Cards only. A charge on a saved card is limited to ₹10,000, or 10,000 in another currency with two decimals. In live mode, Razorpay charges a saved Indian card about 36 hours after notifying the cardholder, and the payment shows as pending until then.
