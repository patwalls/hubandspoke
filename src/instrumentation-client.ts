// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { sentryPrivacyOptions } from "@/lib/sentry-privacy";

// Reports to the self-hosted GlitchTip (https://glitchtip.walls.sh) since
// 2026-11-05. NEXT_PUBLIC_SENTRY_DSN is inlined at BUILD time — set it on
// Heroku before the build. NO USER DATA: sentryPrivacyOptions turns off
// default PII and logs and scrubs every event (no Replay integration).
// Gated on NODE_ENV — Next.js inlines this at build time, so the dev bundle
// skips Sentry init entirely while the Heroku prod bundle keeps it on.
// See docs/automation.md → Error tracking.
if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // 10% perf-trace sampling (errors are still captured at 100%).
    tracesSampleRate: 0.1,
    ...sentryPrivacyOptions,

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
