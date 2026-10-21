// Daily (and on-demand backfill): record which stories past newsletter issues
// ran — HubSpot hand-built Starter Story issues (read-only list call) and
// Klaviyo-era rows — so the drafter never repeats a recent story and the
// editor can show "N× before". Payload `sinceIso` for a backfill (e.g.
// 2026-06-01); default looks back 45 days. Idempotent. See docs/automation.md
// → newsletter-history-sync.
import type { Task } from "graphile-worker";
import { syncNewsletterHistory } from "@/lib/services/newsletter-drafter/history";

export interface NewsletterHistorySyncPayload {
  sinceIso?: string;
}

export const newsletterHistorySyncTask: Task = async (rawPayload, helpers) => {
  const { sinceIso } = (rawPayload ?? {}) as NewsletterHistorySyncPayload;
  const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const r = await syncNewsletterHistory({ since });
  helpers.logger.info(`newsletter-history-sync: since ${since.toISOString().slice(0, 10)} — ${r.hubspot} HubSpot issues, ${r.items} older issues`);
};
