import crypto from 'crypto';
import type { PaymentProvider, PaymentIntentRequest, PaymentIntentResult, WebhookResult } from './types';
import { timingSafeEqualHex } from '@/lib/security/http';

const BASE_URL = process.env.PAYMOB_BASE_URL ?? 'https://accept.paymob.com';
const SECRET = process.env.PAYMOB_SECRET_KEY;
const PUBLIC = process.env.PAYMOB_PUBLIC_KEY;
const HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;

function integrationFor(method: PaymentIntentRequest['paymentMethod']): number | string {
  const value = method === 'card' ? process.env.PAYMOB_CARD_INTEGRATION_ID : method === 'wallet' ? process.env.PAYMOB_WALLET_INTEGRATION_ID : process.env.PAYMOB_FAWRY_INTEGRATION_ID;
  if (!value) throw new Error(`PAYMOB_${method.toUpperCase()}_INTEGRATION_ID is not configured`);
  return /^\d+$/.test(value) ? Number(value) : value;
}

function requireEnv() {
  if (!SECRET || !PUBLIC || !HMAC_SECRET) throw new Error('Paymob credentials are not configured');
}

function hmacValue(obj: any): string {
  // Paymob transaction callback HMAC field order documented by Paymob.
  // Values are concatenated exactly as received, then HMAC-SHA512 is applied.
  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    obj.order?.id,
    obj.owner,
    obj.pending,
    obj.source_data?.pan,
    obj.source_data?.sub_type,
    obj.source_data?.type,
    obj.success,
  ];
  return crypto.createHmac('sha512', HMAC_SECRET!).update(fields.map(v => String(v ?? '')).join('')).digest('hex');
}

function statusOf(obj: any): WebhookResult['status'] {
  if (obj?.is_refunded || obj?.is_refund) return 'refunded';
  if (obj?.is_voided || obj?.is_void) return 'voided';
  if (obj?.pending) return 'pending';
  if (obj?.success === true) return 'success';
  if (obj?.success === false) return 'failed';
  return null;
}

export const paymobProvider: PaymentProvider = {
  id: 'paymob',
  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    requireEnv();
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) throw new Error('Invalid payment amount');
    if (!request.items.length) throw new Error('Paymob requires at least one item');
    const itemSum = request.items.reduce((s, i) => s + i.amountCents, 0);
    if (itemSum !== request.amountCents) throw new Error('Paymob item total does not match order total');
    const integrationId = integrationFor(request.paymentMethod);
    const res = await fetch(`${BASE_URL}/v1/intention/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${SECRET}` },
      body: JSON.stringify({
        amount: request.amountCents,
        currency: request.currency,
        payment_methods: [integrationId],
        items: request.items.map(i => ({ name: i.name, amount: i.amountCents, description: i.description ?? i.name, quantity: i.quantity })),
        billing_data: request.billingData,
        extras: { alora_order_id: request.orderId },
        special_reference: request.orderId,
        ...(request.paymentMethod === 'card' ? { notification_url: request.notificationUrl } : {}),
        ...(request.paymentMethod === 'card' || request.paymentMethod === 'wallet' ? { redirection_url: request.redirectUrl } : {}),
        expiration: 900,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paymob intention failed (${res.status}): ${text.slice(0, 1000)}`);
    let data: any; try { data = JSON.parse(text); } catch { throw new Error('Paymob returned invalid JSON'); }
    if (!data.client_secret || !data.id) throw new Error('Paymob response missing client_secret or intention id');
    return {
      checkoutUrl: `${BASE_URL}/unifiedcheckout/?publicKey=${encodeURIComponent(PUBLIC!)}&clientSecret=${encodeURIComponent(data.client_secret)}`,
      providerReference: String(data.id),
      providerOrderId: data.intention_order_id != null ? String(data.intention_order_id) : undefined,
      intentionId: String(data.id),
      clientSecret: String(data.client_secret),
      integrationId: String(integrationId),
    };
  },
  async verifyWebhook(rawBody: string, _headers: Record<string, string>, queryHmac?: string | null): Promise<WebhookResult> {
    requireEnv();
    let payload: any;
    try { payload = JSON.parse(rawBody); } catch { return { isValid: false, orderId: null, providerOrderId: null, providerReference: null, status: null, amountCents: null, currency: null, integrationId: null, rawPayload: null }; }
    const obj = payload?.obj ?? payload;
    const received = (queryHmac ?? '').trim().toLowerCase();
    const computed = hmacValue(obj);
    const isValid = /^[a-f0-9]{128}$/.test(received) && timingSafeEqualHex(computed, received);
    return {
      isValid,
      orderId: obj?.order?.merchant_order_id ?? obj?.merchant_order_id ?? obj?.payment_key_claims?.extra?.alora_order_id ?? null,
      providerOrderId: obj?.order?.id != null ? String(obj.order.id) : null,
      providerReference: obj?.id != null ? String(obj.id) : null,
      status: statusOf(obj),
      amountCents: Number.isInteger(obj?.amount_cents) ? obj.amount_cents : null,
      refundedAmountCents: Number.isInteger(obj?.refunded_amount_cents) ? obj.refunded_amount_cents : null,
      capturedAmountCents: Number.isInteger(obj?.captured_amount) ? obj.captured_amount : null,
      currency: obj?.currency ?? obj?.order?.currency ?? null,
      integrationId: obj?.integration_id != null ? String(obj.integration_id) : null,
      rawPayload: payload,
    };
  },
};


let cachedInquiryToken: { token: string; expiresAt: number } | null = null;
export async function getPaymobInquiryToken(): Promise<string> {
  const apiKey = process.env.PAYMOB_API_KEY;
  if (!apiKey) throw new Error('PAYMOB_API_KEY is not configured for reconciliation');
  if (cachedInquiryToken && cachedInquiryToken.expiresAt > Date.now() + 60_000) return cachedInquiryToken.token;
  const res = await fetch(`${BASE_URL}/api/auth/tokens`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({api_key:apiKey}) });
  const data:any = await res.json();
  if (!res.ok || !data?.token) throw new Error(`Paymob auth token failed (${res.status})`);
  cachedInquiryToken = { token: String(data.token), expiresAt: Date.now() + 55*60*1000 };
  return cachedInquiryToken.token;
}

export async function inquirePaymobMerchantOrder(merchantOrderId: string): Promise<any> {
  const token = await getPaymobInquiryToken();
  const res = await fetch(`${BASE_URL}/api/ecommerce/orders/transaction_inquiry`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ auth_token:token, merchant_order_id:merchantOrderId }) });
  const data:any = await res.json();
  if (!res.ok) throw new Error(`Paymob inquiry failed (${res.status})`);
  return data;
}
