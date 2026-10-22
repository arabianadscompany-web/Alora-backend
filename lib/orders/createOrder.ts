import { getAdminClient } from '@/lib/auth/server';
import { calculateShipping } from '@/lib/shipping/rates';
import { isValidIdempotencyKey } from '@/lib/security/http';

export interface CreateOrderInput {
  userId: string;
  idempotencyKey: string;
  items: Array<{
    productId: string;
    variantId: string;
    quantity: number;
  }>;
  shippingAddress: Record<string, unknown>;
  paymentMethod: string;
  currency?: 'EGP' | 'USD';
}

export interface CreatedOrder {
  id: string;
  status: string;
  subtotalCents: number;
  shippingFeeCents: number;
  totalCents: number;
  currency: string;
}

type Item = {
  product_id: string;
  variant_id: string;
  quantity: number;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('Invalid identifier');
  }

  return value.toLowerCase();
}

function canonical(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }

  throw new Error('Invalid JSON value');
}

function money(value: unknown): number {
  if (
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^\d+$/.test(value))
  ) {
    throw new Error('Invalid order total');
  }

  const result = Number(value);

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Invalid order total');
  }

  return result;
}

export async function createOrder(
  input: CreateOrderInput
): Promise<CreatedOrder> {
  const userId = uuid(input.userId);

  if (!isValidIdempotencyKey(input.idempotencyKey)) {
    throw new Error('Invalid idempotency key');
  }

  const currency = input.currency ?? 'EGP';

  if (currency !== 'EGP') {
    throw new Error('Only EGP is currently supported');
  }

  if (
    !['card', 'wallet', 'fawry', 'pi_network'].includes(
      input.paymentMethod
    )
  ) {
    throw new Error('Unsupported payment method');
  }

  if (
    !Array.isArray(input.items) ||
    !input.items.length ||
    input.items.length > 100
  ) {
    throw new Error('Invalid cart');
  }

  const merged = new Map<string, Item>();

  for (const item of input.items) {
    if (
      !item ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 50
    ) {
      throw new Error('Invalid cart quantity');
    }

    const productId = uuid(item.productId);
    const variantId = uuid(item.variantId);
    const previous = merged.get(variantId);

    if (previous && previous.product_id !== productId) {
      throw new Error('Product and variant mismatch');
    }

    const quantity = (previous?.quantity ?? 0) + item.quantity;

    if (quantity > 50) {
      throw new Error('Invalid cart quantity');
    }

    merged.set(variantId, {
      product_id: productId,
      variant_id: variantId,
      quantity,
    });
  }

  const items = [...merged.values()].sort((a, b) =>
    a.variant_id.localeCompare(b.variant_id)
  );

  if (!record(input.shippingAddress)) {
    throw new Error('Invalid shipping address');
  }

  const address = input.shippingAddress;

  if (
    typeof address.country !== 'string' ||
    !address.country.trim()
  ) {
    throw new Error('Shipping country is required');
  }

  for (const key of ['governorate', 'city']) {
    if (address[key] != null && typeof address[key] !== 'string') {
      throw new Error('Invalid shipping address');
    }
  }

  const addressKey = canonical(address);

  if (addressKey.length > 16000) {
    throw new Error('Shipping address is too large');
  }

  const quote = calculateShipping({
    country: address.country,
    governorate:
      typeof address.governorate === 'string'
        ? address.governorate
        : undefined,
    city:
      typeof address.city === 'string'
        ? address.city
        : undefined,
    currency,
  });

  if (quote.currency !== currency) {
    throw new Error('Shipping currency mismatch');
  }

  const shippingFeeCents = money(Math.round(quote.fee * 100));
  const db = getAdminClient();

  async function validateOrder(value: unknown): Promise<CreatedOrder> {
    // Never return data or initiate payment before checking ownership.
    if (!record(value) || value.user_id !== userId) {
      throw new Error('FORBIDDEN');
    }

    if (
      value.idempotency_key !== input.idempotencyKey ||
      value.currency !== currency ||
      value.payment_method !== input.paymentMethod ||
      canonical(value.shipping_address) !== addressKey
    ) {
      throw new Error('Idempotency key conflicts with checkout');
    }

    const id = uuid(value.id);

    const { data: lines, error } = await db
      .from('order_items')
      .select('product_id,variant_id,quantity')
      .eq('order_id', id);

    if (error || !lines) {
      throw new Error('Could not verify order items');
    }

    const stored = new Map<string, Item>();

    for (const line of lines) {
      const variantId = uuid(line.variant_id);
      const productId = uuid(line.product_id);
      const quantity = money(line.quantity);
      const previous = stored.get(variantId);

      if (
        quantity < 1 ||
        (previous && previous.product_id !== productId)
      ) {
        throw new Error('Invalid stored order items');
      }

      stored.set(variantId, {
        product_id: productId,
        variant_id: variantId,
        quantity: (previous?.quantity ?? 0) + quantity,
      });
    }

    if (
      stored.size !== items.length ||
      items.some(item => {
        const line = stored.get(item.variant_id);

        return (
          !line ||
          line.product_id !== item.product_id ||
          line.quantity !== item.quantity
        );
      })
    ) {
      throw new Error('Idempotency key conflicts with checkout');
    }

    if (typeof value.status !== 'string') {
      throw new Error('Invalid order status');
    }

    const subtotalCents = money(value.subtotal_cents);
    const savedShipping = money(value.shipping_fee_cents);
    const totalCents = money(value.total_cents);

    if (
      !Number.isSafeInteger(subtotalCents + savedShipping) ||
      totalCents !== subtotalCents + savedShipping
    ) {
      throw new Error('Invalid order total');
    }

    return {
      id,
      status: value.status,
      subtotalCents,
      shippingFeeCents: savedShipping,
      totalCents,
      currency,
    };
  }

  async function findExisting(): Promise<unknown> {
    const { data, error } = await db
      .from('orders')
      .select('*')
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();

    if (error) {
      throw new Error('Could not verify checkout');
    }

    return data;
  }

  const existing = await findExisting();

  if (existing) {
    return validateOrder(existing);
  }

  // SQL still owns pricing, stock locks, reservations and the transaction.
  const { data: variants, error: variantError } = await db
    .from('product_variants')
    .select('id,product_id')
    .in('id', items.map(item => item.variant_id));

  if (variantError || !variants) {
    throw new Error('Could not verify variants');
  }

  const productByVariant = new Map(
    variants.map(variant => [variant.id, variant.product_id])
  );

  if (
    items.some(
      item => productByVariant.get(item.variant_id) !== item.product_id
    )
  ) {
    throw new Error('Product and variant mismatch');
  }

  const { data, error } = await db.rpc('create_order_v2', {
    p_user_id: userId,
    p_idempotency_key: input.idempotencyKey,
    p_items: items,
    p_shipping_address: address,
    p_shipping_fee_cents: shippingFeeCents,
    p_currency: currency,
    p_payment_method: input.paymentMethod,
  });

  if (error) {
    // A concurrent request may have won the unique-key insert.
    // Read the committed order; never repeat reservation blindly.
    if (error.code === '23505') {
      const winner = await findExisting();

      if (winner) {
        return validateOrder(winner);
      }
    }

    throw new Error('Order creation failed');
  }

  return validateOrder(Array.isArray(data) ? data[0] : data);
}
