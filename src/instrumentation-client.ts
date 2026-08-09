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
    // 10% perf-trace sampling (errors are still captured at 100% — this only
    // affects performance traces). 1.0 was span-instrumenting every request
    // on a Basic dyno and burning quota for traces nobody read.
    tracesSampleRate: 0.1,
    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    // Drop "TypeError: Failed to fetch" — never an app bug. The browser
    // throws this when a request never completes (offline, CORS preflight
    // blocked, ad blocker, browser extension wrapping fetch, etc.). Our
    // background pollers (notification-bell, sc-credits-banner) already
    // try/catch their own fetches; these only surface as Sentry events
    // because page-level browser extensions create unhandled rejections
    // outside our await chain — see HUBANDSPOKE-N / HUBANDSPOKE-P, where
    // frame_ant.js was sandwiched in the stacktrace.
    //
    // Also drop `AbortError: signal is aborted without reason` — fired when
    // an in-flight fetch is cancelled by a navigation (router transition,
    // dialog close) before its abort signal can be wired to a reason. Same
    // shape as "Failed to fetch" — never an app bug, just browser teardown
    // racing our promise — see HUBANDSPOKE-S / HUBANDSPOKE-K.
    ignoreErrors: [
      "TypeError: Failed to fetch",
      "TypeError: Load failed",
      "AbortError: signal is aborted without reason",
    ],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
