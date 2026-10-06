// ============================================================================
// Payment provider abstraction.
//
// WHY THIS FILE EXISTS: the business requirement was "make the site
// technically ready so that once Fawry / Vodafone Cash / Visa & Mastercard
// approval comes through, I only need to add the payment provider."
//
// This interface is that seam. The checkout and webhook code (see
// app/api/checkout and app/api/payments/webhook) only ever talk to this
// interface — never to a specific provider's SDK directly. Adding a new
// provider later means writing one new file that implements this interface
// and registering it in provider.ts. Nothing else in the app changes.
// ============================================================================

export type SupportedCurrency = 'EGP' | 'USD';

export interface PaymentIntentRequest {
  orderId: string;
  amount: number;          // in the currency's smallest display unit (e.g. EGP pounds, not piastres — see note in paymob.ts)
  currency: SupportedCurrency;
  customer: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
  /** Where to send the customer after they finish paying (success or failure). */
  redirectUrl: string;
}

export interface PaymentIntentResult {
  /** URL to redirect the customer to (hosted checkout page, iframe, etc). */
  checkoutUrl: string;
  /** The provider's own id for this payment attempt — stored on the order for reconciliation. */
  providerReference: string;
}

/**
 * The result of verifying + parsing an incoming webhook call from a provider.
 * `isValid` MUST be checked before trusting anything else in this object —
 * see the HMAC verification note in paymob.ts.
 */
export interface WebhookResult {
  isValid: boolean;
  orderId: string | null;
  providerReference: string | null;
  status: 'success' | 'failed' | 'pending' | null;
  amount: number | null;
  rawPayload: unknown;
}

export interface PaymentProvider {
  /** Human-readable id used in the `payments.provider` column, e.g. "paymob". */
  readonly id: string;

  /** Start a payment attempt and get back a URL to send the customer to. */
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>;

  /**
   * Verify and parse an incoming webhook request body + headers.
   * Every provider signs its webhooks differently — this is where that
   * provider-specific verification logic lives, hidden behind one shape
   * the rest of the app can trust.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookResult>;
}
