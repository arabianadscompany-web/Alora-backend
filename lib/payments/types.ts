export type SupportedCurrency = 'EGP' | 'USD';
export type PaymentMethod = 'card' | 'wallet' | 'fawry' | 'pi_network';

export interface PaymentLineItem { name: string; amountCents: number; quantity: number; description?: string; }
export interface PaymentIntentRequest {
  orderId: string;
  amountCents: number;
  currency: SupportedCurrency;
  paymentMethod: Exclude<PaymentMethod, 'pi_network'>;
  items: PaymentLineItem[];
  customer: { email: string; firstName: string; lastName: string; phone: string };
  billingData: Record<string, string>;
  redirectUrl: string;
  notificationUrl: string;
}
export interface PaymentIntentResult {
  checkoutUrl: string;
  providerReference: string;
  providerOrderId?: string;
  intentionId?: string;
  clientSecret: string;
  integrationId?: string;
}
export interface WebhookResult {
  isValid: boolean;
  orderId: string | null;
  providerOrderId: string | null;
  providerReference: string | null;
  status: 'success' | 'failed' | 'pending' | 'refunded' | 'voided' | null;
  amountCents: number | null;
  refundedAmountCents?: number | null;
  capturedAmountCents?: number | null;
  currency: string | null;
  integrationId: string | null;
  rawPayload: unknown;
}
export interface PaymentProvider {
  readonly id: string;
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>;
  verifyWebhook(rawBody: string, headers: Record<string, string>, queryHmac?: string | null): Promise<WebhookResult>;
}
