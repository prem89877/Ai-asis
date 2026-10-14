/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // The original-file preview route may be framed by this site only (it sets its own SAMEORIGIN header);
    // every other path keeps X-Frame-Options: DENY.
    const framable = securityHeaders.filter((h) => h.key !== "X-Frame-Options");
    return [
      // Service worker must always be re-checked by the browser so updates roll out immediately.
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      { source: "/api/invoices/:id/file", headers: framable },
      { source: "/((?!api/invoices/[^/]+/file$).*)", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
