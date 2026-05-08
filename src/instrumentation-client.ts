// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Gated on NODE_ENV — Next.js inlines this at build time, so the dev bundle
// (NODE_ENV=development) skips Sentry init entirely while the Heroku prod
// bundle (NODE_ENV=production) keeps it on. Mirrors the DYNO gate on the
// server-side configs. See docs/automation.md → Error tracking.
if (process.env.NODE_ENV === "production") {
  Sentry.init({
    dsn: "https://cc94e45339b831a683f41991a90e811f@o174111.ingest.us.sentry.io/4511350981328896",

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,
    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
