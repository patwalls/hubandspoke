import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Next 16.3+ rewrites CLAUDE.md with its own agent-rules block on every
  // `next dev` run under an agent, leaving every session's tree dirty.
  // CLAUDE.md is hand-maintained here.
  agentRules: false,
  experimental: {
    // Don't store dynamic pages (auth-gated routes) in the client-side router
    // cache. Without this, navigating back to "In Production" or "Content"
    // restores the old React component state instead of remounting and
    // re-fetching, so mutations made on a detail page don't appear until a
    // hard refresh.
    staleTimes: {
      dynamic: 0,
    },
    // Requests pass through src/middleware.ts, which by default keeps only
    // the first 10 MB of a body — a bigger upload arrived truncated and
    // failed as "No file". Routes enforce their own caps (design photos:
    // 15 MB).
    proxyClientMaxBodySize: "25mb",
  },
};

// No source-map upload: errors go to the self-hosted GlitchTip since
// 2026-11-05, and withSentryConfig's upload would call sentry.io (not an
// approved vendor). The wrapper stays for the SDK's build-time instrumentation.
export default withSentryConfig(nextConfig, {
  silent: true,
  sourcemaps: { disable: true },
  telemetry: false,

  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
