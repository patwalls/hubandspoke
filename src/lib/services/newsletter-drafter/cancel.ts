// Cancel a paid newsletter run (draft / redraft / section regenerate / Find
// new story). Queued runs wait NEWSLETTER_START_DELAY_MS before their first
// model call, so a cancel inside that window costs nothing: the queued job is
// removed (graphile `remove_job` is a no-op once a worker holds it) and the
// run checks the row before every model call anyway, so a run already in
// flight stops at the end of its current step and writes nothing.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";

/** Put a `drafting` draft back: `ready` if it already had an issue (a cancelled Redraft keeps it), else `idea`. */
export async function cancelDraftRun(id: string): Promise<boolean> {
  const rows = await db
    .update(newsletterDrafts)
    .set({
      status: sql`CASE WHEN jsonb_array_length(${newsletterDrafts.sections}) > 0 OR COALESCE(${newsletterDrafts.bodyMarkdown}, '') <> '' THEN 'ready' ELSE 'idea' END`,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterDrafts.id, id), eq(newsletterDrafts.status, "drafting")))
    .returning({ id: newsletterDrafts.id });
  await db.execute(sql`SELECT graphile_worker.remove_job(${`newsletter-draft:${id}`})`);
  return rows.length > 0;
}

/** Take a section out of `regenerating` (its run sees that and stops / doesn't save). */
export async function cancelSectionRun(id: string, key: string): Promise<boolean> {
  const rows = await db
    .update(newsletterDrafts)
    .set({
      regenerating: sql`COALESCE((SELECT jsonb_agg(k) FROM jsonb_array_elements_text(${newsletterDrafts.regenerating}) k WHERE k <> ${key}), '[]'::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterDrafts.id, id), sql`jsonb_exists(${newsletterDrafts.regenerating}, ${key})`))
    .returning({ id: newsletterDrafts.id });
  await db.execute(sql`SELECT graphile_worker.remove_job(${`newsletter-section:${id}:${key}`})`);
  return rows.length > 0;
}
