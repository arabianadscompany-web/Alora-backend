// ============================================================================
// EXAMPLE: how a product page should generate its <title>/<meta description>
// and structured data. Drop this pattern into app/products/[slug]/page.tsx
// once that route exists.
// ============================================================================

import type { Metadata } from 'next';
import { productJsonLd, ProductForSeo } from './jsonld';
import { createClient } from '@supabase/supabase-js';

const SITE_URL = process.env.PUBLIC_SITE_URL ?? 'https://alora-lac-zeta.vercel.app';

// Next.js calls this automatically for the page at the matching route —
// this is what makes each product's search-result snippet unique and
// accurate instead of every page sharing one generic title.
export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const product = await getProductBySlug(params.slug); // fetch from Supabase

  return {
    title: `${product.title} | Alora`,
    description: product.description.slice(0, 155), // Google truncates around here anyway
    openGraph: {
      title: product.title,
      description: product.description,
      images: product.images,
      url: `${SITE_URL}/products/${product.slug}`,
    },
    alternates: { canonical: `${SITE_URL}/products/${product.slug}` },
  };
}

// Example page component showing where the JSON-LD script tag goes.
export default async function ProductPage({ params }: { params: { slug: string } }) {
  const product = await getProductBySlug(params.slug);

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product, SITE_URL)) }}
      />
      {/* ...actual page UI... */}
    </>
  );
}

async function getProductBySlug(slug: string): Promise<ProductForSeo> {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await db.from('products').select('title,description,images,base_price_cents,currency,slug,product_variants(stock_quantity,reserved_quantity)').eq('slug',slug).eq('approval_status','APPROVED').eq('is_active',true).single();
  if (error || !data) throw new Error('Product not found');
  const variants = (data.product_variants ?? []) as Array<{stock_quantity:number;reserved_quantity:number}>;
  return { title:data.title, description:data.description ?? '', images:data.images ?? [], price:Number(data.base_price_cents)/100, currency:data.currency, slug:data.slug, inStock:variants.some(v=>v.stock_quantity-v.reserved_quantity>0) };
}
