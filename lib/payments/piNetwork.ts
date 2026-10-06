// ============================================================================
// Pi Network payment provider.
//
// Positioned deliberately as a SECONDARY/optional checkout method, not the
// store's primary payment path — this matches the volatility and platform-
// risk discussion earlier in this project. Paymob (cards + wallets + Fawry)
// should be the default; this provider is offered as an extra choice.
//
// Pi's payment flow is different in shape from a normal hosted-checkout
// provider: the Pi SDK runs *client-side* in the Pi Browser and creates the
// payment there; the server's job is to APPROVE it (before the user
// confirms on-chain) and then COMPLETE it (after the blockchain transaction
// is confirmed) via Pi's server-to-server API. Because of that, this
// provider's `createIntent` does not return a checkout URL the way Paymob's
// does — see the inline notes.
//
// ⚠️ Confirm the exact endpoint paths, payloads, and auth header format
// against Pi's current Platform API docs before going live — Pi's API has
// changed before (see the Mythos/export-control notice elsewhere in this
// project's context) and specifics here may drift.
// ============================================================================

import type {
  PaymentProvider,
  PaymentIntentRequest,
  PaymentIntentResult,
  WebhookResult,
} from './types';

const PI_API_BASE = process.env.PI_API_BASE ?? 'https://api.minepi.com';
const PI_API_KEY = process.env.PI_API_KEY!; // server-side app API key from the Pi Developer Portal

export const piNetworkProvider: PaymentProvider = {
  id: 'pi_network',

  async createIntent(_request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    // There is no server-initiated "create payment" call for Pi — the
    // payment is created by the Pi SDK running in the customer's Pi
    // Browser (client-side), which then calls your backend's /approve
    // endpoint. This method exists only so Pi fits the same
    // PaymentProvider interface as every other provider; the real flow
    // lives in approvePayment() / completePayment() below, called from a
    // dedicated API route the front-end's Pi SDK callbacks hit directly.
    throw new Error(
      'Pi Network payments are created client-side via the Pi SDK, not through createIntent(). ' +
      'Wire the front-end Pi SDK onReadyForServerApproval/onReadyForServerCompletion callbacks to ' +
      'approvePayment() and completePayment() below instead.'
    );
  },

  async verifyWebhook(rawBody: string, _headers: Record<string, string>): Promise<WebhookResult> {
    // Pi does not send provider-initiated webhooks the way Paymob does;
    // confirmation instead happens through the approve/complete calls
    // below, driven by the client SDK's callbacks. Kept here only to
    // satisfy the shared interface.
    return {
      isValid: false,
      orderId: null,
      providerReference: null,
      providerOrderId: null,
      status: null,
      amountCents: null,
      currency: null,
      integrationId: null,
      rawPayload: rawBody,
    };
  },
};

/**
 * Call this from the API route your front-end's Pi SDK
 * `onReadyForServerApproval(paymentId)` callback hits.
 * Approving tells Pi's network your server has reserved the order (via
 * create_order() in db/schema.sql) and it's safe to proceed on-chain.
 */
export async function approvePiPayment(paymentId: string): Promise<void> {
  const res = await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Key ${PI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Pi approve failed: ${await res.text()}`);
}

/**
 * Call this from the API route your front-end's Pi SDK
 * `onReadyForServerCompletion(paymentId, txid)` callback hits — AFTER you
 * have independently verified the blockchain transaction, per Pi's docs.
 */
export async function completePiPayment(paymentId: string, txid: string): Promise<void> {
  const res = await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${PI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ txid }),
  });
  if (!res.ok) throw new Error(`Pi complete failed: ${await res.text()}`);
}
