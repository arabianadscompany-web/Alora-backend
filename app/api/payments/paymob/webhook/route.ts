import { NextRequest, NextResponse } from 'next/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { getAdminClient } from '@/lib/auth/server';

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const hmac = req.nextUrl.searchParams.get('hmac');
    const result = await getPaymentProvider('paymob').verifyWebhook(raw, Object.fromEntries(req.headers.entries()), hmac);
    if (!result.isValid) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    if (!result.providerReference || !result.providerOrderId || !result.orderId || result.amountCents == null || !result.currency) return NextResponse.json({ error: 'Malformed callback' }, { status: 400 });

    const db = getAdminClient();
    const { data: order, error: orderError } = await db.from('orders').select('id,status,total_cents,currency').eq('id', result.orderId).single();
    if (orderError || !order) return NextResponse.json({ error: 'Unknown order' }, { status: 404 });
    if (order.currency !== result.currency || Number(order.total_cents) !== result.amountCents) return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 409 });

    const { data: attempt } = await db.from('payment_attempts').select('id,provider,payment_method,integration_id').eq('order_id', order.id).eq('provider','paymob').eq('provider_order_id',result.providerOrderId).maybeSingle();
    const configuredIntegrations=[process.env.PAYMOB_CARD_INTEGRATION_ID,process.env.PAYMOB_WALLET_INTEGRATION_ID,process.env.PAYMOB_FAWRY_INTEGRATION_ID].filter(Boolean).map(String);
    if (result.integrationId && configuredIntegrations.length && !configuredIntegrations.includes(String(result.integrationId))) return NextResponse.json({ error: 'Payment integration mismatch' }, { status: 409 });
    if (attempt?.integration_id && result.integrationId && String(attempt.integration_id) !== String(result.integrationId)) return NextResponse.json({ error: 'Payment integration mismatch' }, { status: 409 });

    const status = result.status === 'success' ? 'PAID' : result.status === 'refunded' ? ((result.refundedAmountCents ?? 0) >= Number(order.total_cents) ? 'REFUNDED' : 'PARTIALLY_REFUNDED') : result.status === 'voided' ? 'VOIDED' : result.status === 'pending' ? 'PENDING' : 'FAILED';
    const { data: tx, error: txError } = await db.from('payment_transactions').upsert({
      order_id: order.id, payment_attempt_id: attempt?.id ?? null, provider: 'PAYMOB', transaction_id: result.providerReference, provider_order_id: result.providerOrderId,
      status, amount_cents: result.amountCents, currency: result.currency, hmac_verified: true, payload: result.rawPayload, updated_at: new Date().toISOString()
    }, { onConflict: 'provider,transaction_id' }).select('id').single();
    if (txError || !tx) { console.error('[paymob webhook] transaction persistence', txError); return NextResponse.json({ error: 'Could not persist payment event' }, { status: 500 }); }

    if (attempt) {
      const { error: attemptError } = await db.from('payment_attempts').update({ status: status === 'PAID' ? 'SUCCEEDED' : status === 'PENDING' ? 'PENDING' : status === 'FAILED' ? 'FAILED' : status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED' ? 'SUCCEEDED' : 'CANCELLED', updated_at: new Date().toISOString() }).eq('id', attempt.id);
      if (attemptError) console.error('[paymob webhook] attempt status', attemptError);
    }

    const { data: transition, error: transitionError } = await db.rpc('apply_payment_event', { p_order_id: order.id, p_payment_transaction_id: tx.id, p_status: status });
    if (transitionError) {
      console.error('[paymob webhook] transition', transitionError);
      return NextResponse.json({ error: 'Payment recorded; reconciliation required' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status, transition });
  } catch (e) {
    console.error('[paymob webhook] unexpected', e);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
