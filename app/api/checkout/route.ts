import { NextRequest, NextResponse } from 'next/server';

import { createOrder } from '@/lib/orders/createOrder';
import { getPaymentProvider } from '@/lib/payments/provider';
import { getAdminClient, requireRole } from '@/lib/auth/server';
import { isValidIdempotencyKey } from '@/lib/security/http';

const SUPPORTED_PAYMENT_METHODS = [
  'card',
  'wallet',
  'fawry',
  'pi_network',
] as const;

type PaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];

const FINAL_ORDER_STATUSES = [
  'PAID',
  'READY_FOR_FULFILLMENT',
  'SHIPPED',
  'DELIVERED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

const CLOSED_ORDER_STATUSES = [
  'CANCELLED',
  'PAYMENT_FAILED',
];

export async function POST(req: NextRequest) {
  try {
    /*
     * ============================================================
     * 1. AUTHENTICATION
     * ============================================================
     */

    const { appUser } = await requireRole(req, ['customer']);

    /*
     * ============================================================
     * 2. READ REQUEST
     * ============================================================
     */

    const body = await req.json();

    const {
      idempotencyKey,
      items,
      shippingAddress,
      paymentMethod,
      customer,
    } = body;

    /*
     * ============================================================
     * 3. BASIC CHECKOUT VALIDATION
     * ============================================================
     */

    if (
      !isValidIdempotencyKey(idempotencyKey) ||
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 100 ||
      !shippingAddress ||
      !paymentMethod ||
      !customer
    ) {
      return NextResponse.json(
        {
          error: 'Invalid checkout payload',
        },
        { status: 400 }
      );
    }

    /*
     * ============================================================
     * 4. PAYMENT METHOD VALIDATION
     * ============================================================
     *
     * Current live payment routes:
     *
     * card       -> Visa / Mastercard through Paymob
     * wallet     -> Egyptian mobile wallets through Paymob
     * fawry      -> Fawry through Paymob where configured
     * pi_network -> Pi Network client-side payment flow
     *
     * Stablecoins will use a separate provider and will NOT be
     * incorrectly routed through Paymob.
     */

    if (
      !SUPPORTED_PAYMENT_METHODS.includes(
        paymentMethod as PaymentMethod
      )
    ) {
      return NextResponse.json(
        {
          error: 'Unsupported payment method',
        },
        { status: 400 }
      );
    }

    /*
     * ============================================================
     * 5. CUSTOMER VALIDATION
     * ============================================================
     */

    if (
      typeof customer.email !== 'string' ||
      typeof customer.phone !== 'string' ||
      !customer.email.includes('@')
    ) {
      return NextResponse.json(
        {
          error: 'Invalid customer information',
        },
        { status: 400 }
      );
    }

    /*
     * ============================================================
     * 6. CART ITEM VALIDATION
     * ============================================================
     */

    for (const item of items) {
      if (
        !item ||
        typeof item.productId !== 'string' ||
        typeof item.variantId !== 'string' ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 50
      ) {
        return NextResponse.json(
          {
            error: 'Invalid cart item',
          },
          { status: 400 }
        );
      }
    }

    /*
     * ============================================================
     * 7. CREATE / REUSE ORDER
     * ============================================================
     *
     * IMPORTANT:
     * Pricing, stock, commission and shipping are calculated
     * server-side by createOrder().
     *
     * The client cannot decide the final order total.
     */

    const order = await createOrder({
      userId: appUser.id,
      idempotencyKey,
      items,
      shippingAddress,
      paymentMethod,
      currency: 'EGP',
    });

    /*
     * ============================================================
     * 8. ALREADY COMPLETED
     * ============================================================
     */

    if (FINAL_ORDER_STATUSES.includes(order.status)) {
      return NextResponse.json({
        order,
        alreadyProcessed: true,
      });
    }

    /*
     * ============================================================
     * 9. PAYMENT ALREADY PROCESSING
     * ============================================================
     */

    if (order.status === 'PAYMENT_PROCESSING') {
      return NextResponse.json(
        {
          error: 'A payment is already being processed for this order',
          order,
        },
        { status: 409 }
      );
    }

    /*
     * ============================================================
     * 10. CLOSED CHECKOUT
     * ============================================================
     */

    if (CLOSED_ORDER_STATUSES.includes(order.status)) {
      return NextResponse.json(
        {
          error:
            'This checkout attempt is closed. Start a new checkout attempt.',
        },
        { status: 409 }
      );
    }

    /*
     * ============================================================
     * 11. DATABASE ADMIN CLIENT
     * ============================================================
     */

    const db = getAdminClient();

    /*
     * ============================================================
     * 12. REUSE EXISTING PAYMENT ATTEMPT
     * ============================================================
     *
     * VERY IMPORTANT:
     *
     * We must match:
     * - order
     * - provider
     * - payment method
     * - active payment status
     *
     * This prevents a Visa payment attempt from being reused
     * accidentally when the customer switches to Vodafone Cash.
     */

    const providerName =
      paymentMethod === 'pi_network'
        ? 'pi_network'
        : 'paymob';

    const { data: existing } = await db
      .from('payment_attempts')
      .select('*')
      .eq('order_id', order.id)
      .eq('provider', providerName)
      .eq('payment_method', paymentMethod)
      .in('status', ['INITIATED', 'PENDING'])
      .order('created_at', {
        ascending: false,
      })
      .limit(1)
      .maybeSingle();

    /*
     * ============================================================
     * 13. REUSE EXISTING CHECKOUT SESSION
     * ============================================================
     */

    if (
      existing?.checkout_url &&
      existing?.client_secret
    ) {
      return NextResponse.json({
        order,
        checkoutUrl: existing.checkout_url,
        paymentAttemptId: existing.id,
        reused: true,
      });
    }

    /*
     * ============================================================
     * 14. PI NETWORK
     * ============================================================
     *
     * Pi does not go through Paymob.
     *
     * The frontend Pi SDK will handle the actual Pi payment.
     */

    if (paymentMethod === 'pi_network') {
      return NextResponse.json({
        order,
        checkoutUrl: null,
        requiresClientSdk: true,
        paymentAttemptId: existing?.id ?? null,
      });
    }

    /*
     * ============================================================
     * 15. LOAD ORDER ITEMS
     * ============================================================
     */

    const {
      data: lines,
      error: lineError,
    } = await db
      .from('order_items')
      .select(
        'product_id, quantity, unit_price_cents, products(title, description)'
      )
      .eq('order_id', order.id);

    if (lineError) {
      throw new Error(lineError.message);
    }

    if (!lines || lines.length === 0) {
      throw new Error('Order contains no items');
    }

    /*
     * ============================================================
     * 16. PAYMOB PROVIDER
     * ============================================================
     *
     * At this stage:
     *
     * card   = Visa / Mastercard
     * wallet = Egyptian mobile wallets
     * fawry  = Fawry
     *
     * Pi has already been separated above.
     */

    const provider = getPaymentProvider('paymob');

    /*
     * ============================================================
     * 17. CREATE PAYMENT ATTEMPT
     * ============================================================
     */

    const {
      data: attempt,
      error: attemptCreateError,
    } = await db
      .from('payment_attempts')
      .insert({
        order_id: order.id,
        provider: 'paymob',
        payment_method: paymentMethod,
        status: 'INITIATED',
        amount_cents: order.totalCents,
        currency: order.currency,
      })
      .select('id')
      .single();

    if (attemptCreateError || !attempt) {
      throw new Error(
        attemptCreateError?.message ??
          'Could not create payment attempt'
      );
    }

    /*
     * ============================================================
     * 18. PAYMOB BILLING DATA
     * ============================================================
     */

    const billing = {
      email: customer.email,

      first_name:
        typeof customer.firstName === 'string' &&
        customer.firstName.trim()
          ? customer.firstName.trim()
          : 'Alora',

      last_name:
        typeof customer.lastName === 'string' &&
        customer.lastName.trim()
          ? customer.lastName.trim()
          : 'Customer',

      phone_number: customer.phone,

      apartment: String(
        shippingAddress.apartment ?? 'NA'
      ),

      building: String(
        shippingAddress.building ?? 'NA'
      ),

      floor: String(
        shippingAddress.floor ?? 'NA'
      ),

      street: String(
        shippingAddress.street ?? 'NA'
      ),

      city: String(
        shippingAddress.city ?? 'NA'
      ),

      state: String(
        shippingAddress.governorate ??
          shippingAddress.state ??
          'NA'
      ),

      country: String(
        shippingAddress.country ?? 'EG'
      ),

      postal_code: String(
        shippingAddress.postalCode ?? 'NA'
      ),

      extra_description: '',
    };

    /*
     * ============================================================
     * 19. BUILD PAYMOB ITEMS
     * ============================================================
     */

    const itemsForPaymob = (lines ?? []).map(
      (line: any) => ({
        name: String(
          line.products?.title ??
            'ALORA Product'
        ).slice(0, 120),

        amountCents:
          Number(line.unit_price_cents) *
          Number(line.quantity),

        quantity: Number(line.quantity),

        description: String(
          line.products?.description ??
            line.products?.title ??
            'ALORA Product'
        ).slice(0, 200),
      })
    );

    /*
     * Shipping is included in the payment amount.
     */

    itemsForPaymob.push({
      name: 'Shipping',
      amountCents: order.shippingFeeCents,
      quantity: 1,
      description: 'ALORA delivery',
    });

    /*
     * ============================================================
     * 20. CREATE PAYMOB INTENTION
     * ============================================================
     */

    let intent;

    try {
      intent = await provider.createIntent({
        orderId: order.id,

        amountCents: order.totalCents,

        currency: 'EGP',

        paymentMethod: paymentMethod as any,

        items: itemsForPaymob,

        customer,

        billingData: billing,

        redirectUrl:
          `${process.env.PUBLIC_SITE_URL}` +
          `/orders/${order.id}/confirmation`,

        notificationUrl:
          `${process.env.PUBLIC_SITE_URL}` +
          `/api/payments/paymob/webhook`,
      });
    } catch (error) {
      /*
       * If Paymob refuses the request, the payment attempt
       * must not remain active.
       */

      await db
        .from('payment_attempts')
        .update({
          status: 'FAILED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', attempt.id);

      throw error;
    }

    /*
     * ============================================================
     * 21. SAVE PAYMOB REFERENCES
     * ============================================================
     */

    const {
      error: attemptUpdateError,
    } = await db
      .from('payment_attempts')
      .update({
        provider_intention_id:
          intent.intentionId,

        provider_order_id:
          intent.providerOrderId,

        integration_id:
          intent.integrationId,

        client_secret:
          intent.clientSecret,

        checkout_url:
          intent.checkoutUrl,

        updated_at:
          new Date().toISOString(),
      })
      .eq('id', attempt.id);

    if (attemptUpdateError) {
      throw new Error(
        attemptUpdateError.message
      );
    }

    /*
     * ============================================================
     * 22. RETURN PAYMENT CHECKOUT
     * ============================================================
     */

    return NextResponse.json({
      order,

      checkoutUrl:
        intent.checkoutUrl,

      paymentAttemptId:
        attempt.id,

      reused: false,

      paymentMethod,
    });
  } catch (error: any) {
    /*
     * ============================================================
     * ERROR HANDLING
     * ============================================================
     */

    if (
      error?.message ===
      'UNAUTHENTICATED'
    ) {
      return NextResponse.json(
        {
          error:
            'Authentication required',
        },
        { status: 401 }
      );
    }

    if (
      error?.message ===
      'FORBIDDEN'
    ) {
      return NextResponse.json(
        {
          error: 'Forbidden',
        },
        { status: 403 }
      );
    }

    console.error(
      '[ALORA checkout]',
      error
    );

    return NextResponse.json(
      {
        error:
          'Checkout could not be started',
      },
      { status: 500 }
    );
  }
}
