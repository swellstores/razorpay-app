const API_URL = 'https://api.razorpay.com/v1';

export interface RazorpayPayment {
  id: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number;
  currency: string;
  order_id?: string;
  method?: string;
  /** Razorpay returns empty notes as an empty array */
  notes?: Record<string, string> | [];
  card?: { last4?: string; network?: string; type?: string };
  /** Present with `expand[]=token` once the card was saved */
  token?: { id: string; card?: { last4?: string; network?: string; expiry_month?: string; expiry_year?: string } };
}

const SIGNATURE = /^[0-9a-f]{64}$/i;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export default class Razorpay {
  #auth: string;
  #secret: string;

  constructor(keyId: string, keySecret: string) {
    if (!keyId || !keySecret) {
      throw new Error('Razorpay keys are not configured');
    }
    this.#auth = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
    this.#secret = keySecret;
  }

  async #request<T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: { Authorization: this.#auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Razorpay: ${data?.error?.description || response.statusText || response.status}`);
    }
    return data as T;
  }

  createOrder(data: Record<string, unknown>) {
    return this.#request<{ id: string; amount: number; currency: string }>('/orders', 'POST', data);
  }

  createCustomer(data: Record<string, unknown>) {
    return this.#request<{ id: string }>('/customers', 'POST', data);
  }

  getPayment(id: string, expand?: 'card' | 'token') {
    return this.#request<RazorpayPayment>(`/payments/${encodeURIComponent(id)}${expand ? `?expand[]=${expand}` : ''}`);
  }

  /** Charges a saved card token without the shopper present */
  createRecurringPayment(data: Record<string, unknown>) {
    return this.#request<{ razorpay_payment_id: string }>('/payments/create/recurring', 'POST', data);
  }

  updatePayment(id: string, data: { notes: Record<string, string> }) {
    return this.#request<RazorpayPayment>(`/payments/${encodeURIComponent(id)}`, 'PATCH', data);
  }

  capturePayment(id: string, amount: number, currency: string) {
    return this.#request<RazorpayPayment>(`/payments/${encodeURIComponent(id)}/capture`, 'POST', { amount, currency });
  }

  refundPayment(id: string, amount: number) {
    return this.#request<{ id: string }>(`/payments/${encodeURIComponent(id)}/refund`, 'POST', { amount });
  }

  /** Checks the modal's HMAC-SHA256 hex signature of `order_id|payment_id` in constant time */
  async verifySignature(orderId: string, paymentId: string, signature: string): Promise<boolean> {
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.#secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, hexToBytes(signature), encoder.encode(`${orderId}|${paymentId}`));
  }
}
