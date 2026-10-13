// Shared by functions and the component: no secrets here
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);

/** Amount in the currency's smallest unit, as Razorpay expects it */
export function toSubunits(amount: number, currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return Math.round(amount);
  return Math.round(amount * (THREE_DECIMAL.has(code) ? 1000 : 100));
}
