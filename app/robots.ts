import { MetadataRoute } from 'next';

const SITE_URL = process.env.PUBLIC_SITE_URL ?? 'https://alora-lac-zeta.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/api/', '/admin/', '/account/orders/'] },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
