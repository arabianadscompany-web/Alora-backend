-- ============================================================================
-- Alora — Core schema with transaction-safety built in.
-- Run this in the Supabase SQL editor (or any Postgres instance).
--
-- WHY THIS FILE EXISTS:
-- The business requirement was: no lost payments, no double-charging, no
-- overselling, no "booking mix-ups." Those are not solved by application
-- code alone — they are solved by database constraints and a single
-- atomic function that both reserves stock and creates the order in one
-- transaction. That function is at the bottom of this file: create_order().
-- ============================================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique,                    -- maps to Supabase Auth user id
  email text unique not null,
  role text not null default 'customer' check (role in ('customer','seller','admin')),
  created_at timestamptz not null default now()
);

create table sellers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  business_name text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  commission_rate numeric(5,2) not null default 10.00, -- % the platform keeps, e.g. 10.00 = 10%
  payout_info jsonb,
  created_at timestamptz not null default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  parent_id uuid references categories(id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id),
  category_id uuid references categories(id),
  title text not null,
  slug text unique not null,
  description text,
  price numeric(10,2) not null check (price >= 0),
  currency text not null default 'EGP',
  images text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now()
);

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  size text,
  color text,
  stock integer not null default 0 check (stock >= 0),
  price_override numeric(10,2)
);

create table carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) unique,
  created_at timestamptz not null default now()
);

create table cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references carts(id),
  product_id uuid not null references products(id),
  variant_id uuid references product_variants(id),
  quantity integer not null check (quantity > 0),
  unique (cart_id, product_id, variant_id)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  status text not null default 'pending_payment'
    check (status in ('pending_payment','paid','fulfilled','cancelled','payment_failed','refunded')),
  subtotal numeric(10,2) not null,
  total numeric(10,2) not null,
  currency text not null default 'EGP',
  shipping_address jsonb not null,
  payment_method text,
  idempotency_key text unique not null,
  created_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  product_id uuid not null references products(id),
  variant_id uuid references product_variants(id),
  seller_id uuid not null references sellers(id),
  quantity integer not null check (quantity > 0),
  price_at_purchase numeric(10,2) not null,
  commission_rate_at_purchase numeric(5,2) not null
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  provider text not null,
  provider_reference text not null,
  amount numeric(10,2) not null,
  currency text not null,
  status text not null check (status in ('pending','success','failed','refunded')),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (provider, provider_reference)
);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  user_id uuid not null references users(id),
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (product_id, user_id)
);

create table wishlists (
  user_id uuid not null references users(id),
  product_id uuid not null references products(id),
  primary key (user_id, product_id)
);

create table coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value numeric(10,2) not null,
  expires_at timestamptz
);

create table newsletter_subs (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  subscribed_at timestamptz not null default now()
);

create table site_content (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);


create or replace function create_order(
  p_user_id uuid,
  p_idempotency_key text,
  p_items jsonb,
  p_shipping_address jsonb,
  p_currency text default 'EGP'
) returns orders
language plpgsql
as $$
declare
  v_existing orders;
  v_order orders;
  v_item jsonb;
  v_variant product_variants%rowtype;
  v_product products%rowtype;
  v_seller sellers%rowtype;
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
begin
  select * into v_existing from orders where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  insert into orders (user_id, idempotency_key, subtotal, total, currency, shipping_address, status)
  values (p_user_id, p_idempotency_key, 0, 0, p_currency, p_shipping_address, 'pending_payment')
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_variant
      from product_variants
      where id = (v_item->>'variant_id')::uuid
      for update;

    if not found then
      raise exception 'Variant % not found', v_item->>'variant_id';
    end if;

    if v_variant.stock < (v_item->>'quantity')::integer then
      raise exception 'Insufficient stock for variant %', v_variant.id;
    end if;

    select * into v_product from products where id = v_variant.product_id;
    select * into v_seller from sellers where id = v_product.seller_id;

    v_line_total := coalesce(v_variant.price_override, v_product.price) * (v_item->>'quantity')::integer;
    v_subtotal := v_subtotal + v_line_total;

    update product_variants
      set stock = stock - (v_item->>'quantity')::integer
      where id = v_variant.id;

    insert into order_items (
      order_id, product_id, variant_id, seller_id,
      quantity, price_at_purchase, commission_rate_at_purchase
    ) values (
      v_order.id, v_product.id, v_variant.id, v_seller.id,
      (v_item->>'quantity')::integer,
      coalesce(v_variant.price_override, v_product.price),
      v_seller.commission_rate
    );
  end loop;

  update orders set subtotal = v_subtotal, total = v_subtotal
    where id = v_order.id
    returning * into v_order;

  return v_order;
end;
$$;
