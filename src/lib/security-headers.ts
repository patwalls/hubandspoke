/**
 * Browser security headers on every response (S-171), applied by
 * `headers()` in next.config.ts. CSP is limited to frame-ancestors on
 * purpose: a full script/style policy needs nonces across the editors and
 * is its own project. No imports — next.config loads this at build time.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
