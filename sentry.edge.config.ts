// Sentry SDK init for the Next.js edge runtime (middleware, edge routes) (reports to GlitchTip).
import * as Sentry from "@sentry/nextjs";
import { sentryPrivacyOptions } from "@/lib/sentry-privacy";

// Error tracking is a self-hosted GlitchTip (Sentry-SDK compatible,
// https://glitchtip.walls.sh) since 2026-11-05. DSN from SENTRY_DSN; unset =
// nothing is sent. NO USER DATA: sentryPrivacyOptions turns off default PII and
// logs and scrubs every event. Gated on DYNO so local dev errors don't get
// reported tagged `environment: production`. See docs/automation.md → Error tracking.
if (process.env.DYNO && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // 10% perf-trace sampling (errors are still captured at 100%).
    tracesSampleRate: 0.1,
    ...sentryPrivacyOptions,
  });
}
