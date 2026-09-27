/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 's3.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: '*.cloudflare.com',
      },
    ],
  },
  env: {
    // Explicit "" (set by share-mac.command) means "same origin, relative
    // paths" — routed to the local API by the rewrite below instead of a
    // direct cross-origin call. `||` would treat "" as unset, so this
    // checks for undefined specifically.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL !== undefined ? process.env.NEXT_PUBLIC_API_URL : 'http://localhost:4000',
  },
  typescript: {
    tsconfigPath: './tsconfig.json',
  },
  async rewrites() {
    // Lets the browser call same-origin `/api/...` and have this Next
    // server forward it to the local API — used when sharing the app
    // through a single public tunnel (see share-mac.command) so only one
    // public hostname needs a login wall instead of two.
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:4000/api/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
