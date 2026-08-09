// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Gated on DYNO so local dev errors don't get reported tagged
// `environment: production` (Sentry's default when NODE_ENV is unset). See
// docs/automation.md → Error tracking.
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
