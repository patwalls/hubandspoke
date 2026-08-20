import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Don't store dynamic pages (auth-gated routes) in the client-side router
    // cache. Without this, navigating back to "In Production" or "Content"
    // restores the old React component state instead of remounting and
    // re-fetching, so mutations made on a detail page don't appear until a
    // hard refresh.
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default withSentryConfig(nextConfig, {
  org: "pat-walls",
  project: "hubandspoke",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
