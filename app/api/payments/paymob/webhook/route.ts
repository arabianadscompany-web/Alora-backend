import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { getAdminClient } from '@/lib/auth/server';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function providerId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0
      ? String(value)
      : null;
  }

  return typeof value === 'string' &&
    /^[1-9]\d{0,29}$/.test(value)
    ? value
    : null;
}

function cents(value: unknown): number | null {
  if (
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^\d+$/.test(value))
  ) {
    return null;
  }

  const amount = Number(value);

  return Number.isSafeInteger(amount) && amount >= 0
    ? amount
    : null;
}

async function readBody(req: NextRequest): Promise<string> {
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();

  const respond = (
    body: Record<string, unknown>,
    status = 200
  ) =>
    NextResponse.json(
      { ...body, requestId },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Request-ID': requestId,
        },
      }
    );

  const fail = (code: string, status: number) => {
    console.error(
      JSON.stringify({
        event: 'paymob_webhook',
        requestId,
        code,
      })
    );

    return respond({ error: code }, status);
  };

  try {
    const signatures = req.nextUrl.searchParams.getAll('hmac');

    if (
      signatures.length !== 1 ||
      !/^[a-fA-F0-9]{128}$/.test(signatures[0])
    ) {
      return fail('INVALID_SIGNATURE', 401);
    }

    const raw = await readBody(req);
    let payload: unknown;

    try {
      payload = JSON.parse(raw);
    } catch {
      return fail('INVALID_JSON', 400);
    }

    if (!object(payload) || !object(payload.obj)) {
      return fail('INVALID_TRANSACTION_CALLBACK', 400);
    }

    const obj = payload.obj;
    const orderData = obj.order;
    const transactionId = providerId(obj.id);
    const providerOrderId = object(orderData)
      ? providerId(orderData.id)
      : null;
    const integrationId = providerId(obj.integration_id);
    const amount = cents(obj.amount_cents);

    const flags = [
      'success',
      'pending',
      'error_occured',
      'is_auth',
      'is_capture',
      'is_refunded',
      'is_voided',
      'is_standalone_payment',
      'has_parent_transaction',
    ];

    if (
      !transactionId ||
      !providerOrderId ||
      !integrationId ||
      amount === null ||
      typeof obj.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(obj.currency) ||
      flags.some(key => typeof obj[key] !== 'boolean')
    ) {
      return fail('MALFORMED_TRANSACTION', 400);
    }

    const verified = await getPaymentProvider('paymob')
      .verifyWebhook(
        raw,
        Object.fromEntries(req.headers.entries()),
        signatures[0]
      );

    if (!verified.isValid) {
      return fail('INVALID_SIGNATURE', 401);
    }

    const db = getAdminClient();

    // Resolve ALORA's order only through the signed Paymob order ID.
    // Accept historical casing conventions, but require one match.
    const {
      data: attempts,
      error: attemptError,
    } = await db
      .from('payment_attempts')
      .select(
        'id,order_id,provider,payment_method,integration_id,amount_cents,currency'
      )
      .in('provider', ['PAYMOB', 'paymob'])
      .eq('provider_order_id', providerOrderId)
      .limit(2);

    if (attemptError) {
      return fail('ATTEMPT_LOOKUP_FAILED', 503);
    }

    if (!attempts?.length) {
      return fail('PAYMENT_BINDING_NOT_READY', 503);
    }

    if (attempts.length !== 1) {
      return fail('AMBIGUOUS_PAYMENT_BINDING', 409);
    }

    const attempt = attempts[0];

    if (providerId(attempt.integration_id) !== integrationId) {
      return fail('INTEGRATION_MISMATCH', 409);
    }

    const method = String(attempt.payment_method).toLowerCase();

    const configured =
      method === 'card'
        ? process.env.PAYMOB_CARD_INTEGRATION_ID
        : method === 'wallet'
          ? process.env.PAYMOB_WALLET_INTEGRATION_ID
          : method === 'fawry'
            ? process.env.PAYMOB_FAWRY_INTEGRATION_ID
            : undefined;

    if (
      !configured ||
      providerId(configured) !== integrationId
    ) {
      return fail('PAYMENT_CONFIGURATION_MISMATCH', 503);
    }

    const {
      data: order,
      error: orderError,
    } = await db
      .from('orders')
      .select('id,total_cents,currency')
      .eq('id', attempt.order_id)
      .maybeSingle();

    if (orderError || !order) {
      return fail('ORDER_LOOKUP_FAILED', 503);
    }

    if (
      order.currency !== obj.currency ||
      attempt.currency !== obj.currency ||
      cents(order.total_cents) === null ||
      cents(order.total_cents) !== cents(attempt.amount_cents)
    ) {
      return fail('PAYMENT_CONTEXT_MISMATCH', 409);
    }

    // Keep the verified summary, not billing data, PAN or tokens.
    const summary = {
      transactionId,
      providerOrderId,
      integrationId,
      amountCents: amount,
      currency: obj.currency,
      success: obj.success,
      pending: obj.pending,
      errorOccurred: obj.error_occured,
      isAuth: obj.is_auth,
      isCapture: obj.is_capture,
      isRefunded: obj.is_refunded,
      isVoided: obj.is_voided,
      isStandalonePayment: obj.is_standalone_payment,
      hasParentTransaction: obj.has_parent_transaction,
    };

    const eventKey = createHash('sha256')
      .update(signatures[0].toLowerCase())
      .digest('hex');

    const { error: eventError } = await db
      .from('webhook_events')
      .upsert(
        {
          provider: 'PAYMOB',
          event_key: eventKey,
          hmac_verified: true,
          payload: summary,
        },
        {
          onConflict: 'provider,event_key',
          ignoreDuplicates: true,
        }
      );

    if (eventError) {
      return fail('EVENT_PERSISTENCE_FAILED', 503);
    }

    // Refund totals and parent links need provider verification.
    // Never trust unsigned is_refund, is_void or refund totals.
    // Record these events without acknowledging completion.
    if (
      obj.is_refunded ||
      obj.is_voided ||
      obj.is_capture ||
      obj.has_parent_transaction ||
      !obj.is_standalone_payment ||
      obj.is_auth
    ) {
      return fail(
        'PAYMENT_LIFECYCLE_REQUIRES_RECONCILIATION',
        503
      );
    }

    if (amount !== cents(order.total_cents)) {
      return fail('AMOUNT_MISMATCH', 409);
    }

    if (obj.success && obj.error_occured) {
      return fail('CONTRADICTORY_STATUS', 409);
    }

    const status = obj.pending
      ? 'PENDING'
      : obj.success
        ? 'PAID'
        : 'FAILED';

    // Never overwrite transaction ownership through an upsert.
    const { error: insertError } = await db
      .from('payment_transactions')
      .upsert(
        {
          provider: 'PAYMOB',
          transaction_id: transactionId,
          provider_order_id: providerOrderId,
          order_id: order.id,
          payment_attempt_id: attempt.id,
          status,
          amount_cents: amount,
          currency: obj.currency,
          hmac_verified: true,
          payload: summary,
        },
        {
          onConflict: 'provider,transaction_id',
          ignoreDuplicates: true,
        }
      );

    if (insertError) {
      return fail('TRANSACTION_PERSISTENCE_FAILED', 503);
    }

    const {
      data: tx,
      error: txError,
    } = await db
      .from('payment_transactions')
      .select(
        'id,order_id,payment_attempt_id,provider_order_id,amount_cents,currency,status'
      )
      .eq('provider', 'PAYMOB')
      .eq('transaction_id', transactionId)
      .single();

    if (txError || !tx) {
      return fail('TRANSACTION_LOOKUP_FAILED', 503);
    }

    if (
      tx.order_id !== order.id ||
      tx.payment_attempt_id !== attempt.id ||
      tx.provider_order_id !== providerOrderId ||
      tx.currency !== obj.currency ||
      cents(tx.amount_cents) !== amount
    ) {
      return fail('TRANSACTION_BINDING_MISMATCH', 409);
    }

    if (
      ['REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED'].includes(
        tx.status
      )
    ) {
      return respond({ ok: true, ignored: true });
    }

    if (!['PENDING', 'FAILED', 'PAID'].includes(tx.status)) {
      return fail('UNKNOWN_TRANSACTION_STATUS', 409);
    }

    // A delayed pending/failure must not replace PAID.
    const allowed =
      status === 'PAID'
        ? ['PENDING', 'FAILED', 'PAID']
        : status === 'FAILED'
          ? ['PENDING']
          : ['PENDING'];

    const { error: updateError } = await db
      .from('payment_transactions')
      .update({
        status,
        hmac_verified: true,
        payload: summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', tx.id)
      .in('status', allowed);

    if (updateError) {
      return fail('TRANSACTION_UPDATE_FAILED', 503);
    }

    // Failure/pending apply to this transaction.
    // Another payment may succeed for the same order.
    // Do not close the order or release stock here.
    if (status !== 'PAID') {
      return respond({ ok: true, recorded: true });
    }

    // Retry the SQL transition after duplicate callbacks too.
    // A previous request may have crashed after saving payment.
    const {
      data: transition,
      error: transitionError,
    } = await db.rpc('apply_payment_event', {
      p_order_id: order.id,
      p_payment_transaction_id: tx.id,
      p_status: 'PAID',
    });

    if (transitionError) {
      return fail('ORDER_TRANSITION_FAILED', 503);
    }

    const { error: attemptUpdateError } = await db
      .from('payment_attempts')
      .update({
        status: 'SUCCEEDED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', attempt.id)
      .in('status', [
        'INITIATED',
        'PENDING',
        'FAILED',
        'SUCCEEDED',
      ]);

    if (attemptUpdateError) {
      return fail('ATTEMPT_UPDATE_FAILED', 503);
    }

    if (
      ![
        'READY_FOR_FULFILLMENT',
        'SHIPPED',
        'DELIVERED',
      ].includes(String(transition))
    ) {
      return fail('PAID_ORDER_REQUIRES_RECONCILIATION', 503);
    }

    return respond({ ok: true });
  } catch (error: unknown) {
    return fail(
      error instanceof Error &&
        error.message === 'BODY_TOO_LARGE'
        ? 'BODY_TOO_LARGE'
        : 'WEBHOOK_PROCESSING_FAILED',
      error instanceof Error &&
        error.message === 'BODY_TOO_LARGE'
        ? 413
        : 503
    );
  }
}
