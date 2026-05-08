// Sentry init for the worker dyno. Imported as a side effect at the top of
// worker.ts so it runs before graphile-worker and tasks load — keeps init
// ahead of any module-level work that could throw.
//
// Mirrors sentry.server.config.ts but uses @sentry/node directly (the worker
// is not a Next.js process). DSN is intentionally hardcoded — Sentry DSNs are
// public identifiers, designed to be embedded.
//
// Gated on DYNO so local `npm run worker` crashes (e.g. missing DATABASE_URL
// in a fresh checkout) don't pollute the prod Sentry feed — Sentry would
// otherwise default the environment tag to "production" and report them as
// real incidents (see HUBANDSPOKE-M).
import * as Sentry from "@sentry/node";

if (process.env.DYNO) {
  Sentry.init({
    dsn: "https://cc94e45339b831a683f41991a90e811f@o174111.ingest.us.sentry.io/4511350981328896",
    tracesSampleRate: 1,
    enableLogs: true,
    sendDefaultPii: true,
  });
}
