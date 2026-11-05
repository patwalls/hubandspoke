// Sentry SDK init for the worker dyno — reports to the self-hosted GlitchTip
// (https://glitchtip.walls.sh) since 2026-11-05. Imported as a side effect at
// the top of worker.ts so it runs before graphile-worker and tasks load.
//
// Mirrors sentry.server.config.ts but uses @sentry/node directly (the worker
// is not a Next.js process). DSN from SENTRY_DSN; unset = nothing is sent.
// NO USER DATA: sentryPrivacyOptions turns off default PII and logs and
// scrubs every event and transaction.
//
// Gated on DYNO so local `npm run worker` crashes don't pollute the prod feed
// (the SDK would otherwise default the environment tag to "production" —
// see HUBANDSPOKE-M).
import * as Sentry from "@sentry/node";
import { sentryPrivacyOptions } from "@/lib/sentry-privacy";

if (process.env.DYNO && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1,
    ...sentryPrivacyOptions,
  });
}
