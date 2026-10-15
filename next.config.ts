import type { NextConfig } from "next";

// CSP allows self plus Google Analytics (gtag.js from googletagmanager.com).
// frame-ancestors 'none' blocks clickjacking. 'unsafe-inline' is still required
// for Next 15 bootstrap scripts; nonce migration is a separate task. img-src is
// permissive because user-imported quiz images can come from anywhere.
const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "img-src 'self' data: https:",
  "connect-src 'self' wss: https: https://www.google-analytics.com",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      // Site-wide security headers.
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: cspHeader },
        ],
      },
      // Agent-readable surfaces.
      //
      // Cloudflare Tunnel forwards Next.js's headers without rewriting, so
      // this is the right layer for CORS + cache-control on /llms.txt and
      // /robots.txt (analogous to public/_headers on the Astro subdomains
      // that deploy via Cloudflare Pages).
      {
        source: "/llms.txt",
        headers: [
          { key: "Content-Type", value: "text/plain; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=3600, s-maxage=86400" },
        ],
      },
      // PWA: the service worker must never be cached, or updates stall for
      // up to a day behind Cloudflare/browser caches.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      {
        source: "/robots.txt",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, s-maxage=86400" },
        ],
      },
    ];
  },
};

export default nextConfig;
