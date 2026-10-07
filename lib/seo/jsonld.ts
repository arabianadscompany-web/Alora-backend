// ============================================================================
// Structured data (schema.org JSON-LD) for product pages.
//
// This is what actually lets Google show price/rating/availability directly
// in search results ("rich results") — it is the single highest-leverage
// piece of technical SEO for an e-commerce catalog, more impactful than
// generic meta-tag tweaking.
//
// Usage in a Next.js product page (app/products/[slug]/page.tsx):
//
//   import { productJsonLd } from '@/lib/seo/jsonld';
//   ...
//   <script
//     type="application/ld+json"
//     dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product)) }}
//   />
// ============================================================================

export interface ProductForSeo {
  title: string;
  description: string;
  images: string[];
  price: number;
  currency: string;
  slug: string;
  inStock: boolean;
  brand?: string;
  averageRating?: number;
  reviewCount?: number;
}

export function productJsonLd(product: ProductForSeo, siteUrl: string) {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.title,
    description: product.description,
    image: product.images,
    brand: { '@type': 'Brand', name: product.brand ?? 'Alora' },
    offers: {
      '@type': 'Offer',
      url: `${siteUrl}/products/${product.slug}`,
      priceCurrency: product.currency,
      price: product.price,
      availability: product.inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    },
  };

  // Only include aggregateRating if there's at least one real review —
  // Google penalizes structured data with fabricated/placeholder ratings.
  if (product.averageRating && product.reviewCount) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: product.averageRating,
      reviewCount: product.reviewCount,
    };
  }

  return data;
}
