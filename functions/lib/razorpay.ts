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
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

  getPayment(id: string, expandCard = false) {
    return this.#request<RazorpayPayment>(`/payments/${encodeURIComponent(id)}${expandCard ? '?expand[]=card' : ''}`);
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

  async verifySignature(orderId: string, paymentId: string, signature: string): Promise<boolean> {
    return (await hmacSha256(`${orderId}|${paymentId}`, this.#secret)) === signature;
  }
}
