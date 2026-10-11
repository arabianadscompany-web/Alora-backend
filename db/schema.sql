create extension if not exists pgcrypto;

-- ALORA production schema. Money is stored as integer minor units (cents/piastres).
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique not null,
  name text not null,
  email text unique not null,
  phone text,
  password_hash text,
  role text not null default 'customer' check (role in ('customer','seller','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sellers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references users(id) on delete cascade,
  business_name text not null,
  tax_id text,
  country text not null default 'EG',
  bank_account_details jsonb,
  commission_rate numeric(5,4) not null default 0.1500 check (commission_rate >= 0 and commission_rate <= 1),
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  parent_id uuid references categories(id),
  type text not null check (type in ('fashion','beauty')),
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references sellers(id),
  category_id uuid references categories(id),
  title text not null,
  slug text unique not null,
  description text,
  base_price_cents bigint not null check (base_price_cents >= 0),
  currency text not null default 'EGP',
  approval_status text not null default 'PENDING' check (approval_status in ('PENDING','APPROVED','REJECTED')),
  is_active boolean not null default false,
  images text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  sku text unique not null,
  color_name text,
  color_hex text,
  size text,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  price_override_cents bigint check (price_override_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reserved_quantity <= stock_quantity)
);

create table if not exists product_ai_tags (
  product_id uuid primary key references products(id) on delete cascade,
  body_shape_fit text[] not null default '{}',
  color_tone_fit text[] not null default '{}',
  skin_type_target text[] not null default '{}',
  skin_concerns_solved text[] not null default '{}',
  hair_concerns_solved text[] not null default '{}',
  active_ingredients text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  session_id text,
  created_at timestamptz not null default now(),
  check (user_id is not null or session_id is not null)
);
create unique index if not exists carts_user_unique on carts(user_id) where user_id is not null;
create unique index if not exists carts_session_unique on carts(session_id) where session_id is not null;

create table if not exists cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references carts(id) on delete cascade,
  variant_id uuid not null references product_variants(id),
  quantity integer not null check (quantity > 0),
  unique(cart_id, variant_id)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  status text not null default 'PENDING_PAYMENT' check (status in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAID','READY_FOR_FULFILLMENT','SHIPPED','DELIVERED','PAYMENT_FAILED','CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  shipping_fee_cents bigint not null default 0 check (shipping_fee_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),
  currency text not null default 'EGP',
  payment_method text,
  shipping_address jsonb not null,
  idempotency_key text unique not null,
  stock_reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  variant_id uuid not null references product_variants(id),
  product_id uuid not null references products(id),
  seller_id uuid references sellers(id),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity > 0),
  gross_cents bigint not null check (gross_cents >= 0),
  commission_rate numeric(5,4) not null default 0.1500,
  platform_commission_amount_cents bigint not null default 0,
  seller_net_amount_cents bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists seller_ledgers (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id),
  order_id uuid not null references orders(id),
  order_item_id uuid not null references order_items(id),
  gross_sale_cents bigint not null,
  commission_deducted_cents bigint not null,
  net_payout_cents bigint not null,
  payout_status text not null default 'HELD' check (payout_status in ('HELD','READY_FOR_PAYOUT','PAID','REVERSED')),
  created_at timestamptz not null default now(),
  unique(order_item_id)
);

create table if not exists payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  provider text not null,
  payment_method text not null,
  status text not null check (status in ('INITIATED','PENDING','SUCCEEDED','FAILED','EXPIRED','CANCELLED')),
  provider_intention_id text,
  provider_order_id text,
  integration_id text,
  client_secret text,
  checkout_url text,
  amount_cents bigint not null,
  currency text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payment_attempt_provider_intention_unique on payment_attempts(provider, provider_intention_id) where provider_intention_id is not null;
create unique index if not exists payment_attempt_provider_order_unique on payment_attempts(provider, provider_order_id) where provider_order_id is not null;

create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  payment_attempt_id uuid references payment_attempts(id),
  provider text not null,
  transaction_id text not null,
  provider_order_id text,
  status text not null check (status in ('PENDING','PAID','FAILED','REFUNDED','VOIDED','PARTIALLY_REFUNDED')),
  amount_cents bigint not null,
  currency text not null,
  hmac_verified boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, transaction_id)
);

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  seller_id uuid references sellers(id),
  courier_name text not null check (courier_name in ('BOSTA','MYLERZ','DHL','ARAMEX')),
  tracking_number text,
  awb_label_url text,
  status text not null default 'PENDING' check (status in ('PENDING','READY_FOR_PICKUP','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','FAILED','RETURNED')),
  weight_kg numeric(8,3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_recommendation_logs (
  log_id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  input_snapshot jsonb not null,
  recommended_variant_ids text[] not null default '{}',
  feedback_score integer,
  created_at timestamptz not null default now()
);


create table if not exists fulfillment_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  seller_id uuid references sellers(id),
  job_type text not null check(job_type in ('CREATE_SHIPMENT','SEND_ORDER_EMAIL','SELLER_NOTIFICATION')),
  status text not null default 'PENDING' check(status in ('PENDING','PROCESSING','DONE','FAILED')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id,seller_id,job_type)
);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null,
  hmac_verified boolean not null default false,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique(provider, event_key)
);

create index if not exists products_public_idx on products(approval_status,is_active,created_at);
create index if not exists variants_product_idx on product_variants(product_id);
create index if not exists orders_user_idx on orders(user_id,created_at desc);
create index if not exists payment_tx_order_idx on payment_transactions(order_id,created_at desc);
create index if not exists shipments_order_idx on shipments(order_id);

-- Public inventory is safe to query through RLS; all write operations use server-side service role.
alter table products enable row level security;
alter table product_variants enable row level security;
alter table product_ai_tags enable row level security;
create policy "public approved products" on products for select using (approval_status='APPROVED' and is_active=true);
create policy "public variants for approved products" on product_variants for select using (exists(select 1 from products p where p.id=product_id and p.approval_status='APPROVED' and p.is_active=true));
create policy "public ai tags for approved products" on product_ai_tags for select using (exists(select 1 from products p where p.id=product_id and p.approval_status='APPROVED' and p.is_active=true));

create or replace function create_order_v2(
  p_user_id uuid,
  p_idempotency_key text,
  p_items jsonb,
  p_shipping_address jsonb,
  p_shipping_fee_cents bigint,
  p_currency text,
  p_payment_method text
) returns orders
language plpgsql security definer set search_path=public as $$
declare
  v_existing orders;
  v_order orders;
  v_item jsonb;
  v_variant product_variants%rowtype;
  v_product products%rowtype;
  v_seller sellers%rowtype;
  v_unit bigint;
  v_gross bigint;
  v_subtotal bigint := 0;
  v_qty integer;
  v_comm bigint;
  v_net bigint;
begin
  select * into v_existing from orders where idempotency_key=p_idempotency_key for update;
  if found then return v_existing; end if;
  if jsonb_array_length(p_items)=0 then raise exception 'Cart is empty'; end if;
  if p_shipping_fee_cents < 0 then raise exception 'Invalid shipping fee'; end if;

  insert into orders(user_id,status,currency,shipping_address,idempotency_key,payment_method,stock_reserved_until)
  values(p_user_id,'PENDING_PAYMENT',p_currency,p_shipping_address,p_idempotency_key,p_payment_method,now()+interval '15 minutes')
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 50 then raise exception 'Invalid quantity'; end if;
    select * into v_variant from product_variants where id=(v_item->>'variant_id')::uuid for update;
    if not found then raise exception 'Variant not found'; end if;
    select * into v_product from products where id=v_variant.product_id;
    if not found or v_product.approval_status <> 'APPROVED' or not v_product.is_active then raise exception 'Product unavailable'; end if;
    if v_variant.stock_quantity - v_variant.reserved_quantity < v_qty then raise exception 'Insufficient stock'; end if;
    v_unit := coalesce(v_variant.price_override_cents,v_product.base_price_cents);
    v_gross := v_unit * v_qty;
    v_subtotal := v_subtotal + v_gross;
    update product_variants set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_variant.id;
    if v_product.seller_id is null then v_seller := null; else select * into v_seller from sellers where id=v_product.seller_id; end if;
    v_comm := case when v_seller.id is null then 0 else round(v_gross * v_seller.commission_rate)::bigint end;
    v_net := v_gross-v_comm;
    insert into order_items(order_id,variant_id,product_id,seller_id,unit_price_cents,quantity,gross_cents,commission_rate,platform_commission_amount_cents,seller_net_amount_cents)
    values(v_order.id,v_variant.id,v_product.id,v_product.seller_id,v_unit,v_qty,v_gross,coalesce(v_seller.commission_rate,0),v_comm,v_net);
  end loop;
  update orders set subtotal_cents=v_subtotal,shipping_fee_cents=p_shipping_fee_cents,total_cents=v_subtotal+p_shipping_fee_cents,updated_at=now() where id=v_order.id returning * into v_order;
  return v_order;
exception when others then raise;
end; $$;

create or replace function apply_payment_event(p_order_id uuid,p_payment_transaction_id uuid,p_status text)
returns text language plpgsql security definer set search_path=public as $$
declare v_order orders%rowtype; v_item order_items%rowtype;
begin
  select * into v_order from orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if p_status='PAID' then
    if v_order.status in ('PAYMENT_FAILED','CANCELLED') and (v_order.stock_reserved_until is null or v_order.stock_reserved_until <= now()) then
      update orders set status='REFUND_PENDING',updated_at=now() where id=v_order.id;
      return 'REFUND_PENDING';
    end if;
    if v_order.status in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAYMENT_FAILED') then
      update product_variants pv set reserved_quantity=reserved_quantity-oi.quantity, stock_quantity=stock_quantity-oi.quantity, updated_at=now() from order_items oi where oi.order_id=v_order.id and oi.variant_id=pv.id;
      update orders set status='READY_FOR_FULFILLMENT',stock_reserved_until=null,updated_at=now() where id=v_order.id;
      insert into fulfillment_jobs(order_id,seller_id,job_type,status)
      select v_order.id, x.seller_id, 'CREATE_SHIPMENT','PENDING' from (select distinct seller_id from order_items where order_id=v_order.id) x
      on conflict(order_id,seller_id,job_type) do nothing;
      if not exists(select 1 from fulfillment_jobs where order_id=v_order.id and job_type='CREATE_SHIPMENT') then
        insert into fulfillment_jobs(order_id,seller_id,job_type,status) values(v_order.id,null,'CREATE_SHIPMENT','PENDING') on conflict do nothing;
      end if;
      for v_item in select * from order_items where order_id=v_order.id loop
        if v_item.seller_id is not null then
          insert into seller_ledgers(seller_id,order_id,order_item_id,gross_sale_cents,commission_deducted_cents,net_payout_cents,payout_status)
          values(v_item.seller_id,v_order.id,v_item.id,v_item.gross_cents,v_item.platform_commission_amount_cents,v_item.seller_net_amount_cents,'HELD')
          on conflict(order_item_id) do nothing;
        end if;
      end loop;
      return 'PAID';
    end if;
    return v_order.status;
  elsif p_status='FAILED' then
    if v_order.status='PENDING_PAYMENT' or v_order.status='PAYMENT_PROCESSING' then
      update orders set status='PAYMENT_FAILED',updated_at=now() where id=v_order.id;
    end if;
    return 'PAYMENT_FAILED';
  elsif p_status='PARTIALLY_REFUNDED' then
    update orders set status='PARTIALLY_REFUNDED',updated_at=now() where id=v_order.id and status not in ('REFUNDED','CANCELLED');
    return 'PARTIALLY_REFUNDED';
  elsif p_status='REFUNDED' then
    update orders set status='REFUNDED',updated_at=now() where id=v_order.id and status not in ('REFUNDED','CANCELLED');
    update seller_ledgers set payout_status='REVERSED' where order_id=v_order.id and payout_status<>'PAID';
    return 'REFUNDED';
  elsif p_status='VOIDED' then
    update orders set status='CANCELLED',updated_at=now() where id=v_order.id and status in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAID');
    return 'CANCELLED';
  else
    if v_order.status='PENDING_PAYMENT' then update orders set status='PAYMENT_PROCESSING',updated_at=now() where id=v_order.id; end if;
    return 'PAYMENT_PROCESSING';
  end if;
end; $$;

create or replace function release_expired_reservations()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  with expired as (select id from orders where status in ('PENDING_PAYMENT','PAYMENT_FAILED') and stock_reserved_until is not null and stock_reserved_until < now() for update),
  released as (update product_variants pv set reserved_quantity=pv.reserved_quantity-oi.quantity,updated_at=now() from order_items oi join expired e on e.id=oi.order_id where oi.variant_id=pv.id returning pv.id)
  update orders set status='CANCELLED',stock_reserved_until=null,updated_at=now() where id in (select id from expired);
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique(product_id,user_id)
);
create table if not exists wishlists (
  user_id uuid not null references users(id) on delete cascade,
  variant_id uuid not null references product_variants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,variant_id)
);
create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  discount_type text not null check(discount_type in ('percent','fixed')),
  discount_value_cents bigint not null check(discount_value_cents>=0),
  expires_at timestamptz,
  is_active boolean not null default true
);
create table if not exists newsletter_subs (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  subscribed_at timestamptz not null default now()
);
create table if not exists site_content (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
