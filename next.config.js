/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Add real product-image hosts here once Supabase Storage (or another
    // image host) is wired up, e.g.:
    // remotePatterns: [{ protocol: 'https', hostname: '<project>.supabase.co' }],
  },
};

module.exports = nextConfig;
