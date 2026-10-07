import { getAdminClient } from '@/lib/auth/server';
import { calculateShipping } from '@/lib/shipping/rates';

export interface CreateOrderInput {
  userId: string;
  idempotencyKey: string;
  items: Array<{ productId: string; variantId: string; quantity: number }>;
  shippingAddress: Record<string, any>;
  paymentMethod: string;
  currency?: 'EGP' | 'USD';
}
export interface CreatedOrder { id: string; status: string; subtotalCents: number; shippingFeeCents: number; totalCents: number; currency: string; }

export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const db = getAdminClient();
  const quote = calculateShipping({ country: String(input.shippingAddress.country ?? ''), governorate: input.shippingAddress.governorate, city: input.shippingAddress.city, currency: input.currency });
  const merged = new Map<string, { product_id: string; variant_id: string; quantity: number }>();
  for (const i of input.items) { const key=i.variantId; const prev=merged.get(key); merged.set(key,{product_id:i.productId,variant_id:i.variantId,quantity:(prev?.quantity??0)+i.quantity}); }
  const normalizedItems = [...merged.values()];
  const { data, error } = await db.rpc('create_order_v2', {
    p_user_id: input.userId,
    p_idempotency_key: input.idempotencyKey,
    p_items: normalizedItems,
    p_shipping_address: input.shippingAddress,
    p_shipping_fee_cents: Math.round(quote.fee * 100),
    p_currency: input.currency ?? 'EGP',
    p_payment_method: input.paymentMethod,
  });
  if (error) throw new Error(error.message);
  const row: any = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Order creation returned no order');
  return { id: row.id, status: row.status, subtotalCents: Number(row.subtotal_cents), shippingFeeCents: Number(row.shipping_fee_cents), totalCents: Number(row.total_cents), currency: row.currency };
}
