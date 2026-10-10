import { NextRequest, NextResponse } from 'next/server';
import { createOrder } from '@/lib/orders/createOrder';
import { getPaymentProvider } from '@/lib/payments/provider';
import { getAdminClient, requireRole } from '@/lib/auth/server';
import { isValidIdempotencyKey } from '@/lib/security/http';

export async function POST(req: NextRequest) {
  try {
    const { appUser } = await requireRole(req, ['customer']);
    const body = await req.json();
    const { idempotencyKey, items, shippingAddress, paymentMethod, customer } = body;
    if (!isValidIdempotencyKey(idempotencyKey) || !Array.isArray(items) || items.length < 1 || items.length > 100 || !shippingAddress || !paymentMethod || !customer) return NextResponse.json({ error: 'Invalid checkout payload' }, { status: 400 });
    if (!['card','wallet','fawry','pi_network'].includes(paymentMethod)) return NextResponse.json({ error: 'Unsupported payment method' }, { status: 400 });
    if (typeof customer.email !== 'string' || typeof customer.phone !== 'string' || !customer.email.includes('@')) return NextResponse.json({ error: 'Invalid customer information' }, { status: 400 });
    for (const i of items) if (!i?.productId || !i?.variantId || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 50) return NextResponse.json({ error: 'Invalid cart item' }, { status: 400 });

    const order = await createOrder({ userId: appUser.id, idempotencyKey, items, shippingAddress, paymentMethod, currency: 'EGP' });
    if (['PAID','READY_FOR_FULFILLMENT','SHIPPED','DELIVERED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'].includes(order.status)) return NextResponse.json({ order, alreadyProcessed: true });
    if (order.status === 'PAYMENT_PROCESSING') return NextResponse.json({ error: 'A payment is already being processed for this order', order }, { status: 409 });
    if (['CANCELLED','PAYMENT_FAILED'].includes(order.status)) return NextResponse.json({ error: 'This checkout attempt is closed. Start a new checkout attempt.' }, { status: 409 });
    const db = getAdminClient();
    const { data: existing } = await db.from('payment_attempts').select('*').eq('order_id', order.id).eq('provider', paymentMethod === 'pi_network' ? 'pi_network' : 'paymob').in('status',['INITIATED','PENDING']).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (existing?.checkout_url && existing.client_secret) return NextResponse.json({ order, checkoutUrl: existing.checkout_url, paymentAttemptId: existing.id, reused: true });
    if (paymentMethod === 'pi_network') return NextResponse.json({ order, checkoutUrl: null, requiresClientSdk: true });

    const { data: lines, error: lineError } = await db.from('order_items').select('product_id, quantity, unit_price_cents, products(title, description)').eq('order_id', order.id);
    if (lineError) throw new Error(lineError.message);
    const provider = getPaymentProvider('paymob');
    const { data: attempt, error: attemptCreateError } = await db.from('payment_attempts').insert({ order_id: order.id, provider: 'paymob', payment_method: paymentMethod, status: 'INITIATED', amount_cents: order.totalCents, currency: order.currency }).select('id').single();
    if (attemptCreateError || !attempt) throw new Error(attemptCreateError?.message ?? 'Could not create payment attempt');
    const billing = {
      email: customer.email, first_name: customer.firstName ?? 'Alora', last_name: customer.lastName ?? 'Customer', phone_number: customer.phone,
      apartment: String(shippingAddress.apartment ?? 'NA'), building: String(shippingAddress.building ?? 'NA'), floor: String(shippingAddress.floor ?? 'NA'), street: String(shippingAddress.street ?? 'NA'), city: String(shippingAddress.city ?? 'NA'), state: String(shippingAddress.governorate ?? shippingAddress.state ?? 'NA'), country: String(shippingAddress.country ?? 'EG'), postal_code: String(shippingAddress.postalCode ?? 'NA'), extra_description: ''
    };
    const itemsForPaymob = (lines ?? []).map((l: any) => ({ name: String(l.products?.title ?? 'ALORA Product').slice(0,120), amountCents: Number(l.unit_price_cents) * Number(l.quantity), quantity: Number(l.quantity), description: String(l.products?.description ?? l.products?.title ?? 'ALORA Product').slice(0,200) }));
    itemsForPaymob.push({ name: 'Shipping', amountCents: order.shippingFeeCents, quantity: 1, description: 'ALORA delivery' });
    let intent;
    try {
      intent = await provider.createIntent({ orderId: order.id, amountCents: order.totalCents, currency: 'EGP', paymentMethod: paymentMethod as any, items: itemsForPaymob, customer, billingData: billing, redirectUrl: `${process.env.PUBLIC_SITE_URL}/orders/${order.id}/confirmation`, notificationUrl: `${process.env.PUBLIC_SITE_URL}/api/payments/paymob/webhook` });
    } catch (e) {
      await db.from('payment_attempts').update({ status: 'FAILED', updated_at: new Date().toISOString() }).eq('id', attempt.id);
      throw e;
    }
    const { error: attemptUpdateError } = await db.from('payment_attempts').update({ provider_intention_id: intent.intentionId, provider_order_id: intent.providerOrderId, integration_id: intent.integrationId, client_secret: intent.clientSecret, checkout_url: intent.checkoutUrl, updated_at: new Date().toISOString() }).eq('id', attempt.id);
    if (attemptUpdateError) throw new Error(attemptUpdateError.message);
    return NextResponse.json({ order, checkoutUrl: intent.checkoutUrl, paymentAttemptId: attempt.id });
  } catch (e: any) {
    if (e?.message === 'UNAUTHENTICATED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    console.error('[checkout]', e);
    return NextResponse.json({ error: 'Checkout could not be started' }, { status: 500 });
  }
}
