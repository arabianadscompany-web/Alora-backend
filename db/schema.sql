/* ============================================================
   ALORA — PRODUCTION DATABASE SCHEMA
   PostgreSQL / Supabase
   Version: Production v2

   Architecture:
   Supabase Auth
        ↓
   public.users
        ↓
   Customers / Sellers / Admins
        ↓
   Products / Variants
        ↓
   Cart
        ↓
   Atomic Order + Stock Reservation
        ↓
   Paymob Payment Attempts
        ↓
   Verified Payment Webhook
        ↓
   Seller Ledger
        ↓
   Fulfillment Jobs
        ↓
   Shipments / AWB
   ============================================================ */


/* ============================================================
   1. EXTENSIONS / PRIVATE SCHEMA
   ============================================================ */

create extension if not exists pgcrypto;

create schema if not exists private;


/* ============================================================
   2. UPDATED_AT TRIGGER
   ============================================================ */

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public;


/* ============================================================
   3. USERS
   Supabase Auth is the source of identity.
   public.users stores ALORA application profile data.
   ============================================================ */

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),

  auth_id uuid unique not null
    references auth.users(id)
    on delete cascade,

  name text not null,
  email text unique not null,
  phone text,

  role text not null default 'customer'
    check (role in ('customer','seller','admin')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


/* ============================================================
   4. SELLERS
   ============================================================ */

create table if not exists public.sellers (
  id uuid primary key default gen_random_uuid(),

  user_id uuid unique not null
    references public.users(id)
    on delete cascade,

  business_name text not null,
  tax_id text,
  country text not null default 'EG',

  bank_account_details jsonb,

  commission_rate numeric(5,4) not null default 0.1500
    check (commission_rate >= 0 and commission_rate <= 1),

  status text not null default 'PENDING'
    check (status in ('PENDING','ACTIVE','SUSPENDED')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


/* ============================================================
   5. CATEGORIES
   ============================================================ */

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  slug text unique not null,

  parent_id uuid
    references public.categories(id)
    on delete set null,

  type text not null
    check (type in ('fashion','beauty')),

  created_at timestamptz not null default now()
);


/* ============================================================
   6. PRODUCTS
   seller_id NULL = ALORA-owned product
   ============================================================ */

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),

  seller_id uuid
    references public.sellers(id)
    on delete set null,

  category_id uuid
    references public.categories(id)
    on delete set null,

  title text not null,
  slug text unique not null,
  description text,

  base_price_cents bigint not null
    check (base_price_cents >= 0),

  currency text not null default 'EGP'
    check (currency = 'EGP'),

  approval_status text not null default 'PENDING'
    check (approval_status in ('PENDING','APPROVED','REJECTED')),

  is_active boolean not null default false,

  images text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


/* ============================================================
   7. PRODUCT VARIANTS
   ============================================================ */

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),

  product_id uuid not null
    references public.products(id)
    on delete cascade,

  sku text unique not null,

  color_name text,
  color_hex text,
  size text,

  stock_quantity integer not null default 0
    check (stock_quantity >= 0),

  reserved_quantity integer not null default 0
    check (reserved_quantity >= 0),

  price_override_cents bigint
    check (price_override_cents >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (reserved_quantity <= stock_quantity)
);


/* ============================================================
   8. AI PRODUCT TAGS
   ============================================================ */

create table if not exists public.product_ai_tags (
  product_id uuid primary key
    references public.products(id)
    on delete cascade,

  body_shape_fit text[] not null default '{}',
  color_tone_fit text[] not null default '{}',

  skin_type_target text[] not null default '{}',
  skin_concerns_solved text[] not null default '{}',

  hair_concerns_solved text[] not null default '{}',
  active_ingredients text[] not null default '{}',

  updated_at timestamptz not null default now()
);


/* ============================================================
   9. CARTS
   ============================================================ */

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),

  user_id uuid
    references public.users(id)
    on delete cascade,

  session_id text,

  created_at timestamptz not null default now(),

  check (
    user_id is not null
    or session_id is not null
  )
);

create unique index if not exists carts_user_unique
on public.carts(user_id)
where user_id is not null;

create unique index if not exists carts_session_unique
on public.carts(session_id)
where session_id is not null;


/* ============================================================
   10. CART ITEMS
   ============================================================ */

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),

  cart_id uuid not null
    references public.carts(id)
    on delete cascade,

  variant_id uuid not null
    references public.product_variants(id)
    on delete restrict,

  quantity integer not null
    check (quantity > 0),

  unique(cart_id, variant_id)
);


/* ============================================================
   11. ORDERS
   ============================================================ */

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references public.users(id)
    on delete restrict,

  status text not null default 'PENDING_PAYMENT'
    check (
      status in (
        'PENDING_PAYMENT',
        'PAYMENT_PROCESSING',
        'PAID',
        'READY_FOR_FULFILLMENT',
        'SHIPPED',
        'DELIVERED',
        'PAYMENT_FAILED',
        'CANCELLED',
        'REFUND_PENDING',
        'PARTIALLY_REFUNDED',
        'REFUNDED'
      )
    ),

  subtotal_cents bigint not null default 0
    check (subtotal_cents >= 0),

  shipping_fee_cents bigint not null default 0
    check (shipping_fee_cents >= 0),

  total_cents bigint not null default 0
    check (total_cents >= 0),

  currency text not null default 'EGP'
    check (currency = 'EGP'),

  payment_method text,

  shipping_address jsonb not null,

  idempotency_key text unique not null,

  stock_reserved_until timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (
    total_cents = subtotal_cents + shipping_fee_cents
  )
);


/* ============================================================
   12. ORDER ITEMS
   ============================================================ */

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders(id)
    on delete cascade,

  variant_id uuid not null
    references public.product_variants(id)
    on delete restrict,

  product_id uuid not null
    references public.products(id)
    on delete restrict,

  seller_id uuid
    references public.sellers(id)
    on delete set null,

  unit_price_cents bigint not null
    check (unit_price_cents >= 0),

  quantity integer not null
    check (quantity > 0),

  gross_cents bigint not null
    check (gross_cents >= 0),

  commission_rate numeric(5,4) not null default 0
    check (commission_rate >= 0 and commission_rate <= 1),

  platform_commission_amount_cents bigint not null default 0
    check (platform_commission_amount_cents >= 0),

  seller_net_amount_cents bigint not null default 0
    check (seller_net_amount_cents >= 0),

  created_at timestamptz not null default now(),

  check (
    gross_cents = unit_price_cents * quantity
  ),

  check (
    seller_net_amount_cents =
      gross_cents - platform_commission_amount_cents
  )
);


/* ============================================================
   13. SELLER LEDGER
   ============================================================ */

create table if not exists public.seller_ledgers (
  id uuid primary key default gen_random_uuid(),

  seller_id uuid not null
    references public.sellers(id)
    on delete restrict,

  order_id uuid not null
    references public.orders(id)
    on delete restrict,

  order_item_id uuid not null
    references public.order_items(id)
    on delete restrict,

  gross_sale_cents bigint not null
    check (gross_sale_cents >= 0),

  commission_deducted_cents bigint not null
    check (commission_deducted_cents >= 0),

  net_payout_cents bigint not null
    check (net_payout_cents >= 0),

  payout_status text not null default 'HELD'
    check (
      payout_status in (
        'HELD',
        'READY_FOR_PAYOUT',
        'PAID',
        'REVERSED'
      )
    ),

  created_at timestamptz not null default now(),

  unique(order_item_id),

  check (
    gross_sale_cents =
      commission_deducted_cents + net_payout_cents
  )
);


/* ============================================================
   14. PAYMENT ATTEMPTS
   ============================================================ */

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders(id)
    on delete cascade,

  provider text not null
    check (provider in ('PAYMOB','FAWRY')),

  payment_method text not null
    check (
      payment_method in (
        'CARD',
        'WALLET',
        'FAWRY'
      )
    ),

  status text not null
    check (
      status in (
        'INITIATED',
        'PENDING',
        'SUCCEEDED',
        'FAILED',
        'EXPIRED',
        'CANCELLED'
      )
    ),

  provider_intention_id text,

  provider_order_id text,

  integration_id text,

  /*
    Stored only server-side.
    Never expose this column through client RLS.
  */
  client_secret text,

  checkout_url text,

  amount_cents bigint not null
    check (amount_cents >= 0),

  currency text not null
    check (currency = 'EGP'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists
payment_attempt_provider_intention_unique
on public.payment_attempts(provider, provider_intention_id)
where provider_intention_id is not null;

create unique index if not exists
payment_attempt_provider_order_unique
on public.payment_attempts(provider, provider_order_id)
where provider_order_id is not null;


/* ============================================================
   15. PAYMENT TRANSACTIONS
   ============================================================ */

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders(id)
    on delete restrict,

  payment_attempt_id uuid
    references public.payment_attempts(id)
    on delete set null,

  provider text not null
    check (provider in ('PAYMOB','FAWRY')),

  transaction_id text not null,

  provider_order_id text,

  status text not null
    check (
      status in (
        'PENDING',
        'PAID',
        'FAILED',
        'REFUNDED',
        'VOIDED',
        'PARTIALLY_REFUNDED'
      )
    ),

  amount_cents bigint not null
    check (amount_cents >= 0),

  currency text not null
    check (currency = 'EGP'),

  hmac_verified boolean not null default false,

  payload jsonb not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(provider, transaction_id)
);

create index if not exists payment_tx_order_idx
on public.payment_transactions(order_id, created_at desc);


/* ============================================================
   16. SHIPMENTS
   ============================================================ */

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders(id)
    on delete restrict,

  seller_id uuid
    references public.sellers(id)
    on delete set null,

  courier_name text not null
    check (
      courier_name in (
        'BOSTA',
        'MYLERZ',
        'DHL',
        'ARAMEX'
      )
    ),

  tracking_number text,

  awb_label_url text,

  status text not null default 'PENDING'
    check (
      status in (
        'PENDING',
        'READY_FOR_PICKUP',
        'PICKED_UP',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'FAILED',
        'RETURNED'
      )
    ),

  weight_kg numeric(8,3)
    check (weight_kg is null or weight_kg > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shipments_order_idx
on public.shipments(order_id);


/* ============================================================
   17. AI RECOMMENDATION LOGS
   ============================================================ */

create table if not exists public.ai_recommendation_logs (
  log_id uuid primary key default gen_random_uuid(),

  user_id uuid
    references public.users(id)
    on delete set null,

  input_snapshot jsonb not null,

  recommended_variant_ids text[]
    not null default '{}',

  feedback_score integer
    check (
      feedback_score is null
      or feedback_score between 1 and 5
    ),

  created_at timestamptz not null default now()
);


/* ============================================================
   18. FULFILLMENT JOBS
   ============================================================ */

create table if not exists public.fulfillment_jobs (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders(id)
    on delete cascade,

  seller_id uuid
    references public.sellers(id)
    on delete set null,

  job_type text not null
    check (
      job_type in (
        'CREATE_SHIPMENT',
        'SEND_ORDER_EMAIL',
        'SELLER_NOTIFICATION'
      )
    ),

  status text not null default 'PENDING'
    check (
      status in (
        'PENDING',
        'PROCESSING',
        'DONE',
        'FAILED'
      )
    ),

  attempts integer not null default 0
    check (attempts >= 0),

  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(order_id, seller_id, job_type)
);


/* ============================================================
   19. WEBHOOK EVENTS
   Idempotency for external callbacks.
   ============================================================ */

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),

  provider text not null,

  event_key text not null,

  hmac_verified boolean not null default false,

  payload jsonb not null,

  received_at timestamptz not null default now(),

  unique(provider, event_key)
);


/* ============================================================
   20. REVIEWS
   ============================================================ */

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),

  product_id uuid not null
    references public.products(id)
    on delete cascade,

  user_id uuid not null
    references public.users(id)
    on delete cascade,

  rating integer not null
    check (rating between 1 and 5),

  comment text,

  created_at timestamptz not null default now(),

  unique(product_id, user_id)
);


/* ============================================================
   21. WISHLISTS
   ============================================================ */

create table if not exists public.wishlists (
  user_id uuid not null
    references public.users(id)
    on delete cascade,

  variant_id uuid not null
    references public.product_variants(id)
    on delete cascade,

  created_at timestamptz not null default now(),

  primary key(user_id, variant_id)
);


/* ============================================================
   22. COUPONS
   ============================================================ */

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),

  code text unique not null,

  discount_type text not null
    check (discount_type in ('percent','fixed')),

  discount_value_cents bigint not null
    check (discount_value_cents >= 0),

  expires_at timestamptz,

  is_active boolean not null default true
);


/* ============================================================
   23. NEWSLETTER
   ============================================================ */

create table if not exists public.newsletter_subs (
  id uuid primary key default gen_random_uuid(),

  email text unique not null,

  subscribed_at timestamptz not null default now()
);


/* ============================================================
   24. SITE CONTENT
   ============================================================ */

create table if not exists public.site_content (
  key text primary key,

  value jsonb not null,

  updated_at timestamptz not null default now()
);


/* ============================================================
   25. UPDATED_AT TRIGGERS
   ============================================================ */

drop trigger if exists trg_users_updated_at
on public.users;

create trigger trg_users_updated_at
before update on public.users
for each row
execute function private.set_updated_at();


drop trigger if exists trg_sellers_updated_at
on public.sellers;

create trigger trg_sellers_updated_at
before update on public.sellers
for each row
execute function private.set_updated_at();


drop trigger if exists trg_products_updated_at
on public.products;

create trigger trg_products_updated_at
before update on public.products
for each row
execute function private.set_updated_at();


drop trigger if exists trg_product_variants_updated_at
on public.product_variants;

create trigger trg_product_variants_updated_at
before update on public.product_variants
for each row
execute function private.set_updated_at();


drop trigger if exists trg_product_ai_tags_updated_at
on public.product_ai_tags;

create trigger trg_product_ai_tags_updated_at
before update on public.product_ai_tags
for each row
execute function private.set_updated_at();


drop trigger if exists trg_orders_updated_at
on public.orders;

create trigger trg_orders_updated_at
before update on public.orders
for each row
execute function private.set_updated_at();


drop trigger if exists trg_payment_attempts_updated_at
on public.payment_attempts;

create trigger trg_payment_attempts_updated_at
before update on public.payment_attempts
for each row
execute function private.set_updated_at();


drop trigger if exists trg_payment_transactions_updated_at
on public.payment_transactions;

create trigger trg_payment_transactions_updated_at
before update on public.payment_transactions
for each row
execute function private.set_updated_at();


drop trigger if exists trg_shipments_updated_at
on public.shipments;

create trigger trg_shipments_updated_at
before update on public.shipments
for each row
execute function private.set_updated_at();


drop trigger if exists trg_fulfillment_jobs_updated_at
on public.fulfillment_jobs;

create trigger trg_fulfillment_jobs_updated_at
before update on public.fulfillment_jobs
for each row
execute function private.set_updated_at();


drop trigger if exists trg_site_content_updated_at
on public.site_content;

create trigger trg_site_content_updated_at
before update on public.site_content
for each row
execute function private.set_updated_at();


/* ============================================================
   26. AUTOMATIC ALORA USER PROFILE AFTER SUPABASE SIGNUP
   ============================================================ */

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  insert into public.users (
    auth_id,
    name,
    email,
    phone,
    role
  )
  values (
    new.id,

    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, new.phone, new.id::text), '@', 1)
    ),

    coalesce(
      new.email,
      new.raw_user_meta_data ->> 'email',
      new.id::text || '@alora.local'
    ),

    coalesce(
      new.phone,
      new.raw_user_meta_data ->> 'phone'
    ),

    'customer'
  )
  on conflict (auth_id)
  do update set
    email = excluded.email,
    name = excluded.name,
    phone = excluded.phone,
    updated_at = now();

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created
on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();


/* ============================================================
   27. ATOMIC ORDER CREATION
   - Server-side only
   - Locks variants
   - Aggregates duplicate variant IDs
   - Reserves stock
   - Uses database prices
   - Calculates commission from database
   ============================================================ */

create or replace function public.create_order_v2(
  p_user_id uuid,
  p_idempotency_key text,
  p_items jsonb,
  p_shipping_address jsonb,
  p_shipping_fee_cents bigint,
  p_currency text,
  p_payment_method text
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$

declare

  v_existing public.orders;
  v_order public.orders;

  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  v_seller public.sellers%rowtype;

  v_item record;

  v_unit bigint;
  v_gross bigint;
  v_subtotal bigint := 0;
  v_qty integer;

  v_commission bigint;
  v_net bigint;

begin

  /* ----------------------------------------------------------
     Basic validation
     ---------------------------------------------------------- */

  if p_user_id is null then
    raise exception 'User is required';
  end if;

  if p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8
     or length(p_idempotency_key) > 200 then
    raise exception 'Invalid idempotency key';
  end if;

  if p_currency <> 'EGP' then
    raise exception 'Only EGP is currently supported';
  end if;

  if p_shipping_fee_cents is null
     or p_shipping_fee_cents < 0 then
    raise exception 'Invalid shipping fee';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Cart is empty';
  end if;


  /* ----------------------------------------------------------
     Idempotency
     ---------------------------------------------------------- */

  select *
  into v_existing
  from public.orders
  where idempotency_key = p_idempotency_key
  for update;

  if found then
    return v_existing;
  end if;


  /* ----------------------------------------------------------
     Verify user exists
     ---------------------------------------------------------- */

  if not exists (
    select 1
    from public.users
    where id = p_user_id
  ) then
    raise exception 'User not found';
  end if;


  /* ----------------------------------------------------------
     Create order
     ---------------------------------------------------------- */

  insert into public.orders (
    user_id,
    status,
    currency,
    shipping_address,
    idempotency_key,
    payment_method,
    stock_reserved_until
  )
  values (
    p_user_id,
    'PENDING_PAYMENT',
    p_currency,
    p_shipping_address,
    p_idempotency_key,
    p_payment_method,
    now() + interval '15 minutes'
  )
  returning *
  into v_order;


  /* ----------------------------------------------------------
     Aggregate duplicate variants before reservation
     ---------------------------------------------------------- */

  for v_item in

    select
      x.variant_id,
      sum(x.quantity)::integer as quantity

    from jsonb_to_recordset(p_items)
      as x(
        variant_id uuid,
        quantity integer
      )

    group by x.variant_id

  loop

    v_qty := v_item.quantity;

    if v_item.variant_id is null then
      raise exception 'Variant ID is required';
    end if;

    if v_qty < 1 or v_qty > 50 then
      raise exception 'Invalid quantity';
    end if;


    /* --------------------------------------------------------
       Lock variant
       -------------------------------------------------------- */

    select *
    into v_variant

    from public.product_variants

    where id = v_item.variant_id

    for update;


    if not found then
      raise exception 'Variant not found';
    end if;


    /* --------------------------------------------------------
       Load product
       -------------------------------------------------------- */

    select *
    into v_product

    from public.products

    where id = v_variant.product_id;


    if not found
       or v_product.approval_status <> 'APPROVED'
       or v_product.is_active = false then

      raise exception 'Product unavailable';

    end if;


    /* --------------------------------------------------------
       Seller validation
       ALORA-owned products have NULL seller_id.
       Marketplace products require ACTIVE seller.
       -------------------------------------------------------- */

    if v_product.seller_id is not null then

      select *
      into v_seller

      from public.sellers

      where id = v_product.seller_id;

      if not found then
        raise exception 'Seller not found';
      end if;

      if v_seller.status <> 'ACTIVE' then
        raise exception 'Seller is not active';
      end if;

    else

      v_seller := null;

    end if;


    /* --------------------------------------------------------
       Stock check
       -------------------------------------------------------- */

    if (
      v_variant.stock_quantity
      - v_variant.reserved_quantity
    ) < v_qty then

      raise exception 'Insufficient stock';

    end if;


    /* --------------------------------------------------------
       Server-side price
       NEVER trust frontend price.
       -------------------------------------------------------- */

    v_unit :=
      coalesce(
        v_variant.price_override_cents,
        v_product.base_price_cents
      );


    v_gross := v_unit * v_qty;

    v_subtotal :=
      v_subtotal + v_gross;


    /* --------------------------------------------------------
       Reserve stock
       -------------------------------------------------------- */

    update public.product_variants

    set
      reserved_quantity =
        reserved_quantity + v_qty,

      updated_at = now()

    where id = v_variant.id;


    /* --------------------------------------------------------
       Commission
       ALORA-owned product = 0%
       Seller product = seller commission
       -------------------------------------------------------- */

    v_commission :=
      case

        when v_product.seller_id is null
        then 0

        else round(
          v_gross::numeric
          * v_seller.commission_rate
        )::bigint

      end;


    v_net :=
      v_gross - v_commission;


    /* --------------------------------------------------------
       Order item
       -------------------------------------------------------- */

    insert into public.order_items (

      order_id,
      variant_id,
      product_id,
      seller_id,

      unit_price_cents,
      quantity,
      gross_cents,

      commission_rate,

      platform_commission_amount_cents,
      seller_net_amount_cents

    )

    values (

      v_order.id,
      v_variant.id,
      v_product.id,
      v_product.seller_id,

      v_unit,
      v_qty,
      v_gross,

      case
        when v_product.seller_id is null
        then 0
        else v_seller.commission_rate
      end,

      v_commission,
      v_net

    );

  end loop;


  /* ----------------------------------------------------------
     Final order totals
     ---------------------------------------------------------- */

  update public.orders

  set
    subtotal_cents = v_subtotal,

    shipping_fee_cents =
      p_shipping_fee_cents,

    total_cents =
      v_subtotal + p_shipping_fee_cents,

    updated_at = now()

  where id = v_order.id

  returning *
  into v_order;


  return v_order;

end;
$$;


/* ------------------------------------------------------------
   Lock order creation function to backend/service role.
   ------------------------------------------------------------ */

revoke all
on function public.create_order_v2(
  uuid,
  text,
  jsonb,
  jsonb,
  bigint,
  text,
  text
)
from public, anon, authenticated;

grant execute
on function public.create_order_v2(
  uuid,
  text,
  jsonb,
  jsonb,
  bigint,
  text,
  text
)
to service_role;


/* ============================================================
   28. APPLY VERIFIED PAYMENT EVENT
   IMPORTANT:
   This function is NOT the HMAC verifier.
   HMAC verification happens in the backend.
   This function applies an already-verified event atomically.
   ============================================================ */

create or replace function public.apply_payment_event(
  p_order_id uuid,
  p_payment_transaction_id uuid,
  p_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$

declare

  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;

begin

  select *
  into v_order

  from public.orders

  where id = p_order_id

  for update;


  if not found then
    raise exception 'Order not found';
  end if;


  /* ----------------------------------------------------------
     SUCCESSFUL PAYMENT
     ---------------------------------------------------------- */

  if p_status = 'PAID' then


    /* --------------------------------------------------------
       If reservation expired before payment callback:
       NEVER fulfill.
       Backend must initiate refund.
       -------------------------------------------------------- */

    if v_order.stock_reserved_until is null
       or v_order.stock_reserved_until <= now() then

      if v_order.status in (
        'PENDING_PAYMENT',
        'PAYMENT_PROCESSING',
        'PAYMENT_FAILED'
      ) then

        update public.orders

        set
          status = 'REFUND_PENDING',
          updated_at = now()

        where id = v_order.id;

        return 'REFUND_PENDING';

      end if;

    end if;


    /* --------------------------------------------------------
       Idempotent PAID processing
       -------------------------------------------------------- */

    if v_order.status = 'READY_FOR_FULFILLMENT'
       or v_order.status = 'SHIPPED'
       or v_order.status = 'DELIVERED' then

      return v_order.status;

    end if;


    if v_order.status in (
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING'
    ) then


      /* ------------------------------------------------------
         Convert reservation → sold stock
         ------------------------------------------------------ */

      update public.product_variants pv

      set
        reserved_quantity =
          pv.reserved_quantity - oi.quantity,

        stock_quantity =
          pv.stock_quantity - oi.quantity,

        updated_at = now()

      from public.order_items oi

      where
        oi.order_id = v_order.id

        and oi.variant_id = pv.id;


      /* ------------------------------------------------------
         Update order
         ------------------------------------------------------ */

      update public.orders

      set
        status = 'READY_FOR_FULFILLMENT',

        stock_reserved_until = null,

        updated_at = now()

      where id = v_order.id;


      /* ------------------------------------------------------
         Create shipment jobs
         ------------------------------------------------------ */

      insert into public.fulfillment_jobs (
        order_id,
        seller_id,
        job_type,
        status
      )

      select distinct
        v_order.id,
        oi.seller_id,
        'CREATE_SHIPMENT',
        'PENDING'

      from public.order_items oi

      where oi.order_id = v_order.id

      on conflict (
        order_id,
        seller_id,
        job_type
      )
      do nothing;


      /* ------------------------------------------------------
         Create ALORA shipment job if all items are ALORA-owned
         ------------------------------------------------------ */

      if not exists (
        select 1
        from public.fulfillment_jobs
        where order_id = v_order.id
          and job_type = 'CREATE_SHIPMENT'
          and seller_id is null
      )
      and not exists (
        select 1
        from public.order_items
        where order_id = v_order.id
          and seller_id is null
      ) then

        null;

      end if;


      /* ------------------------------------------------------
         Seller ledger
         ------------------------------------------------------ */

      for v_item in

        select *
        from public.order_items

        where order_id = v_order.id

      loop

        if v_item.seller_id is not null then

          insert into public.seller_ledgers (

            seller_id,
            order_id,
            order_item_id,

            gross_sale_cents,
            commission_deducted_cents,
            net_payout_cents,

            payout_status

          )

          values (

            v_item.seller_id,
            v_order.id,
            v_item.id,

            v_item.gross_cents,
            v_item.platform_commission_amount_cents,
            v_item.seller_net_amount_cents,

            'HELD'

          )

          on conflict (order_item_id)
          do nothing;

        end if;

      end loop;


      return 'READY_FOR_FULFILLMENT';

    end if;


    return v_order.status;


  /* ==========================================================
     PAYMENT FAILED
     ========================================================== */

  elsif p_status = 'FAILED' then

    if v_order.status in (
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING'
    ) then

      update public.orders

      set
        status = 'PAYMENT_FAILED',
        updated_at = now()

      where id = v_order.id;

    end if;

    return 'PAYMENT_FAILED';


  /* ==========================================================
     PARTIAL REFUND
     ========================================================== */

  elsif p_status = 'PARTIALLY_REFUNDED' then

    update public.orders

    set
      status = 'PARTIALLY_REFUNDED',
      updated_at = now()

    where id = v_order.id

      and status not in (
        'REFUNDED',
        'CANCELLED'
      );

    return 'PARTIALLY_REFUNDED';


  /* ==========================================================
     FULL REFUND
     ========================================================== */

  elsif p_status = 'REFUNDED' then

    update public.orders

    set
      status = 'REFUNDED',
      updated_at = now()

    where id = v_order.id

      and status <> 'REFUNDED';


    update public.seller_ledgers

    set payout_status = 'REVERSED'

    where order_id = v_order.id

      and payout_status <> 'PAID';


    return 'REFUNDED';


  /* ==========================================================
     VOID
     ========================================================== */

  elsif p_status = 'VOIDED' then

    update public.orders

    set
      status = 'CANCELLED',
      updated_at = now()

    where id = v_order.id

      and status in (
        'PENDING_PAYMENT',
        'PAYMENT_PROCESSING'
      );


    return 'CANCELLED';


  /* ==========================================================
     ANY OTHER PAYMENT PROCESSING STATE
     ========================================================== */

  else

    if v_order.status = 'PENDING_PAYMENT' then

      update public.orders

      set
        status = 'PAYMENT_PROCESSING',
        updated_at = now()

      where id = v_order.id;

    end if;

    return 'PAYMENT_PROCESSING';

  end if;

end;
$$;


/* ------------------------------------------------------------
   Backend/service role only.
   ------------------------------------------------------------ */

revoke all
on function public.apply_payment_event(
  uuid,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.apply_payment_event(
  uuid,
  uuid,
  text
)
to service_role;


/* ============================================================
   29. RELEASE EXPIRED STOCK RESERVATIONS
   ============================================================ */

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$

declare
  v_count integer := 0;

begin

  /*
    Lock expired orders first.
  */

  with expired_orders as (

    select id

    from public.orders

    where status in (
      'PENDING_PAYMENT',
      'PAYMENT_FAILED'
    )

    and stock_reserved_until is not null

    and stock_reserved_until < now()

    for update

  ),

  released as (

    update public.product_variants pv

    set
      reserved_quantity =
        pv.reserved_quantity - oi.quantity,

      updated_at = now()

    from public.order_items oi

    join expired_orders eo
      on eo.id = oi.order_id

    where
      pv.id = oi.variant_id

      and pv.reserved_quantity >= oi.quantity

    returning pv.id

  )

  update public.orders o

  set
    status = 'CANCELLED',

    stock_reserved_until = null,

    updated_at = now()

  where o.id in (
    select id
    from expired_orders
  );


  get diagnostics v_count = row_count;

  return v_count;

end;
$$;


revoke all
on function public.release_expired_reservations()
from public, anon, authenticated;

grant execute
on function public.release_expired_reservations()
to service_role;


/* ============================================================
   30. INDEXES
   ============================================================ */

create index if not exists products_public_idx
on public.products(
  approval_status,
  is_active,
  created_at desc
);

create index if not exists products_seller_idx
on public.products(seller_id);

create index if not exists products_category_idx
on public.products(category_id);

create index if not exists variants_product_idx
on public.product_variants(product_id);

create index if not exists variants_sku_idx
on public.product_variants(sku);

create index if not exists orders_user_idx
on public.orders(user_id, created_at desc);

create index if not exists orders_status_idx
on public.orders(status, created_at desc);

create index if not exists order_items_order_idx
on public.order_items(order_id);

create index if not exists order_items_seller_idx
on public.order_items(seller_id);

create index if not exists seller_ledgers_seller_idx
on public.seller_ledgers(seller_id, created_at desc);

create index if not exists payment_attempts_order_idx
on public.payment_attempts(order_id, created_at desc);

create index if not exists payment_transactions_order_idx
on public.payment_transactions(
  order_id,
  created_at desc
);

create index if not exists shipments_order_idx
on public.shipments(order_id);

create index if not exists shipments_tracking_idx
on public.shipments(tracking_number);

create index if not exists fulfillment_jobs_status_idx
on public.fulfillment_jobs(
  status,
  created_at
);

create index if not exists webhook_events_provider_idx
on public.webhook_events(
  provider,
  received_at desc
);

create index if not exists ai_logs_user_idx
on public.ai_recommendation_logs(
  user_id,
  created_at desc
);


/* ============================================================
   31. ROW LEVEL SECURITY
   ============================================================ */

/*
  SECURITY PRINCIPLE:

  Public catalog:
    anon + authenticated → READ ONLY

  Customer private data:
    customer → only own records

  Seller financial/payment data:
    backend/service role only

  Admin:
    backend/service role only

  No client is allowed to write payment/order/ledger data directly.
*/


/* ------------------------------------------------------------
   Enable RLS everywhere.
   ------------------------------------------------------------ */

alter table public.users enable row level security;
alter table public.sellers enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_ai_tags enable row level security;

alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

alter table public.seller_ledgers enable row level security;

alter table public.payment_attempts enable row level security;
alter table public.payment_transactions enable row level security;

alter table public.shipments enable row level security;

alter table public.ai_recommendation_logs enable row level security;

alter table public.fulfillment_jobs enable row level security;
alter table public.webhook_events enable row level security;

alter table public.reviews enable row level security;
alter table public.wishlists enable row level security;
alter table public.coupons enable row level security;
alter table public.newsletter_subs enable row level security;
alter table public.site_content enable row level security;


/* ============================================================
   32. REMOVE OLD POLICIES IF RE-RUN
   ============================================================ */

drop policy if exists "public approved products"
on public.products;

drop policy if exists "public variants for approved products"
on public.product_variants;

drop policy if exists "public ai tags for approved products"
on public.product_ai_tags;

drop policy if exists "users read own profile"
on public.users;

drop policy if exists "customers read own orders"
on public.orders;

drop policy if exists "customers read own order items"
on public.order_items;

drop policy if exists "customers read own shipments"
on public.shipments;

drop policy if exists "customers manage own wishlist"
on public.wishlists;

drop policy if exists "customers read own reviews"
on public.reviews;


/* ============================================================
   33. PUBLIC CATALOG POLICIES
   ============================================================ */

create policy "public approved products"
on public.products

for select

to anon, authenticated

using (
  approval_status = 'APPROVED'
  and is_active = true
);


create policy "public variants for approved products"
on public.product_variants

for select

to anon, authenticated

using (
  exists (
    select 1

    from public.products p

    where p.id = product_id

      and p.approval_status = 'APPROVED'

      and p.is_active = true
  )
);


create policy "public ai tags for approved products"
on public.product_ai_tags

for select

to anon, authenticated

using (
  exists (
    select 1

    from public.products p

    where p.id = product_id

      and p.approval_status = 'APPROVED'

      and p.is_active = true
  )
);


/* ============================================================
   34. USER SELF-READ POLICY
   No client update of role/security fields.
   ============================================================ */

create policy "users read own profile"
on public.users

for select

to authenticated

using (
  (select auth.uid()) = auth_id
);


/* ============================================================
   35. CUSTOMER ORDER READ
   ============================================================ */

create policy "customers read own orders"
on public.orders

for select

to authenticated

using (
  user_id = (
    select u.id
    from public.users u
    where u.auth_id = (select auth.uid())
  )
);


create policy "customers read own order items"
on public.order_items

for select

to authenticated

using (
  exists (
    select 1

    from public.orders o

    join public.users u
      on u.id = o.user_id

    where o.id = order_id

      and u.auth_id = (select auth.uid())
  )
);


/* ============================================================
   36. CUSTOMER SHIPMENT READ
   ============================================================ */

create policy "customers read own shipments"
on public.shipments

for select

to authenticated

using (
  exists (
    select 1

    from public.orders o

    join public.users u
      on u.id = o.user_id

    where o.id = order_id

      and u.auth_id = (select auth.uid())
  )
);


/* ============================================================
   37. WISHLIST
   ============================================================ */

create policy "customers manage own wishlist"
on public.wishlists

for all

to authenticated

using (
  user_id = (
    select u.id
    from public.users u
    where u.auth_id = (select auth.uid())
  )
)

with check (
  user_id = (
    select u.id
    from public.users u
    where u.auth_id = (select auth.uid())
  )
);


/* ============================================================
   38. REVIEWS
   ============================================================ */

create policy "customers read own reviews"
on public.reviews

for select

to authenticated

using (
  user_id = (
    select u.id
    from public.users u
    where u.auth_id = (select auth.uid())
  )
);


/* ============================================================
   39. GRANTS
   ============================================================ */

/*
  Public catalog read access.
*/

grant select
on public.products
to anon, authenticated;

grant select
on public.product_variants
to anon, authenticated;

grant select
on public.product_ai_tags
to anon, authenticated;


/*
  Customer profile read.
*/

grant select
on public.users
to authenticated;


/*
  Customer order history read.
*/

grant select
on public.orders
to authenticated;

grant select
on public.order_items
to authenticated;

grant select
on public.shipments
to authenticated;


/*
  Wishlist.
*/

grant select, insert, delete
on public.wishlists
to authenticated;


/*
  Everything else stays backend/service-role only.
*/


/* ============================================================
   40. EXPLICITLY REMOVE SENSITIVE CLIENT ACCESS
   ============================================================ */

revoke all
on public.sellers
from anon, authenticated;

revoke all
on public.carts
from anon, authenticated;

revoke all
on public.cart_items
from anon, authenticated;

revoke all
on public.seller_ledgers
from anon, authenticated;

revoke all
on public.payment_attempts
from anon, authenticated;

revoke all
on public.payment_transactions
from anon, authenticated;

revoke all
on public.fulfillment_jobs
from anon, authenticated;

revoke all
on public.webhook_events
from anon, authenticated;

revoke all
on public.ai_recommendation_logs
from anon, authenticated;

revoke all
on public.site_content
from anon, authenticated;


/* ============================================================
   41. SERVICE ROLE ACCESS
   ============================================================ */

grant all
on all tables in schema public
to service_role;

grant all
on all sequences in schema public
to service_role;


/* ============================================================
   42. FINAL SECURITY DEFAULTS
   ============================================================ */

alter default privileges in schema public
revoke all on tables
from anon, authenticated;

alter default privileges in schema public
grant all on tables
to service_role;

alter default privileges in schema public
revoke all on sequences
from anon, authenticated;

alter default privileges in schema public
grant all on sequences
to service_role;


/* ============================================================
   43. FINAL SCHEMA CHECKS
   ============================================================ */

do $$
begin

  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_auth_id_fkey'
  ) then
    raise exception 'Auth FK was not created correctly';
  end if;


  if not exists (
    select 1
    from pg_indexes
    where indexname =
      'payment_tx_order_idx'
  ) then
    raise exception 'Payment transaction index missing';
  end if;


  if not exists (
    select 1
    from pg_indexes
    where indexname =
      'payment_attempt_provider_intention_unique'
  ) then
    raise exception 'Payment intention idempotency index missing';
  end if;


  raise notice
    'ALORA production schema installed successfully.';

end;
$$;
