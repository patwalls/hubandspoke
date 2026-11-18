import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { USUAL_EDITOR_RUN, usualEditorOf } from "@/lib/cross-post-usual";

export interface UsualEditor {
  userId: string;
  name: string | null;
}

/**
 * Per cross-post target on `brand` (`<accountId>:<postType>`), the editor its
 * cross-posts always end up with — see `usualEditorOf`. Reads each target's
 * latest cross-posts from the last 60 days that are at least 10 minutes old
 * (time for the hand-off to have happened). Deactivated editors never count.
 */
export async function getUsualCrossPostEditors(brand: string): Promise<Record<string, UsualEditor>> {
  const rows = await db.execute<{
    account_id: string;
    post_type: string;
    editor_user_id: string | null;
    creator_user_id: string | null;
  }>(sql`
    WITH cp AS (
      SELECT p.id, p.account_id, p.post_type, p.editor_user_id,
             row_number() OVER (PARTITION BY p.account_id, p.post_type ORDER BY p.created_at DESC) AS rn
        FROM production_items p
       WHERE p.brand = ${brand}
         AND p.source_type = 'cross_post'
         AND p.deleted_at IS NULL
         AND p.account_id IS NOT NULL
         AND p.post_type IS NOT NULL
         AND p.created_at < now() - interval '10 minutes'
         AND p.created_at > now() - interval '60 days'
    )
    SELECT cp.account_id, cp.post_type, cp.editor_user_id,
           (SELECT e.user_id FROM content_events e
             WHERE e.content_item_id = cp.id AND e.event_type = 'item_created'
             ORDER BY e.created_at LIMIT 1) AS creator_user_id
      FROM cp
     WHERE cp.rn <= ${USUAL_EDITOR_RUN}
     ORDER BY cp.account_id, cp.post_type, cp.rn
  `);

  const byTarget = new Map<string, { editorUserId: string | null; creatorUserId: string | null }[]>();
  for (const r of Array.from(rows)) {
    const key = `${r.account_id}:${r.post_type}`;
    const list = byTarget.get(key) ?? [];
    list.push({ editorUserId: r.editor_user_id, creatorUserId: r.creator_user_id });
    byTarget.set(key, list);
  }
  const picks = new Map<string, string>();
  for (const [key, recent] of byTarget) {
    const editor = usualEditorOf(recent);
    if (editor) picks.set(key, editor);
  }
  if (picks.size === 0) return {};

  const ids = [...new Set(picks.values())];
  const people = await db.execute<{ id: string; name: string | null }>(sql`
    SELECT id, name FROM users
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND deactivated_at IS NULL
  `);
  const nameOf = new Map(Array.from(people).map((u) => [u.id, u.name]));
  const out: Record<string, UsualEditor> = {};
  for (const [key, userId] of picks) {
    if (nameOf.has(userId)) out[key] = { userId, name: nameOf.get(userId) ?? null };
  }
  return out;
}
