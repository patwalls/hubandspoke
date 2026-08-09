// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Gated on DYNO so local dev errors don't get reported tagged
// `environment: production`. See docs/automation.md → Error tracking.
if (process.env.DYNO) {
  Sentry.init({
    dsn: "https://cc94e45339b831a683f41991a90e811f@o174111.ingest.us.sentry.io/4511350981328896",

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    // 10% perf-trace sampling (errors are still captured at 100% — this only
    // affects performance traces). 1.0 was span-instrumenting every request
    // on a Basic dyno and burning quota for traces nobody read.
    tracesSampleRate: 0.1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  });
}
