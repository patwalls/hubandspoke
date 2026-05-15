/**
 * One-shot cleanup of pre-V7 clip ideas + their paired pre-created
 * production_items. The V7 Splice prompt landed alongside an anchor-quote
 * + cue-snap pipeline that earlier versions don't have, so V4–V6 ideas
 * carry stale windows (and, since the 2026-05-15 alignment-snap fix, the
 * spatial framing across the V7 set itself is now better than anything
 * before). Cleaning them out so the operator UI isn't cluttered with old
 * "Idea" rows that nobody is going to act on.
 *
 * Scope:
 *   - clip_ideas WHERE prompt_version < 7 AND status = 'suggested'.
 *   - The paired production_items pre-created at clip-idea generation
 *     time (status='Idea' AND source_clip_idea_id = ci.id). These rows
 *     are byproducts of the suggested clip idea — if we drop the idea,
 *     the orphan placeholder has no purpose.
 *
 * NOT in scope:
 *   - clip_ideas with status='assigned' or 'killed'. Those are real
 *     decisions (a freelancer/operator already promoted or killed the
 *     idea) and the back-link is part of the audit trail.
 *   - production_items whose status moved past 'Idea' (e.g. someone
 *     bumped one to 'In Progress' before V7 shipped). Leave them.
 *
 * Defaults to dry-run.
 *
 *   heroku run --app hubandspoke -- node scripts/cleanup-pre-v7-clip-ideas.mjs
 *   heroku run --app hubandspoke -- node scripts/cleanup-pre-v7-clip-ideas.mjs --apply
 */
import postgres from "postgres";

const CURRENT_PROMPT_VERSION = 7;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  const breakdown = await sql`
    SELECT prompt_version, status, COUNT(*)::int AS n
    FROM clip_ideas
    WHERE prompt_version < ${CURRENT_PROMPT_VERSION}
    GROUP BY prompt_version, status
    ORDER BY prompt_version DESC, status
  `;

  const targets = await sql`
    SELECT ci.id          AS clip_idea_id,
           ci.prompt_version,
           ci.hook,
           pi.id           AS prod_item_id,
           pi.status       AS prod_item_status
    FROM clip_ideas ci
    LEFT JOIN production_items pi
      ON pi.source_clip_idea_id = ci.id
     AND pi.status = 'Idea'
    WHERE ci.prompt_version < ${CURRENT_PROMPT_VERSION}
      AND ci.status = 'suggested'
    ORDER BY ci.prompt_version DESC, ci.created_at DESC
  `;

  const clipIdeaIds = targets.map((r) => r.clip_idea_id);
  const prodItemIds = targets.map((r) => r.prod_item_id).filter(Boolean);

  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log(`\nPre-V${CURRENT_PROMPT_VERSION} clip_ideas in the table (all statuses):`);
  for (const row of breakdown) {
    console.log(`  v${row.prompt_version} ${row.status}: ${row.n}`);
  }

  console.log(`\nIn scope (suggested-status pre-V${CURRENT_PROMPT_VERSION} only):`);
  console.log(`  clip_ideas to delete:      ${clipIdeaIds.length}`);
  console.log(`  paired production_items:   ${prodItemIds.length}`);
  console.log(`  (production_items NOT at status='Idea' are preserved)`);

  if (clipIdeaIds.length === 0) {
    console.log("\nNothing to do.");
    await sql.end();
    return;
  }

  if (dryRun) {
    console.log(`\nSample (first 20):`);
    for (const row of targets.slice(0, 20)) {
      const hook = (row.hook ?? "").slice(0, 60);
      const pairTag = row.prod_item_id ? " (+ paired Idea)" : "";
      console.log(`  v${row.prompt_version}  ${row.clip_idea_id}${pairTag}  ${hook}`);
    }
    if (targets.length > 20) {
      console.log(`  … and ${targets.length - 20} more`);
    }
    console.log(`\nDRY RUN — pass --apply to commit.`);
    await sql.end();
    return;
  }

  // Apply in a single transaction. Order matters: production_items first
  // (they hold the FK; their content_events cascade via ON DELETE CASCADE),
  // clip_ideas second.
  await sql.begin(async (tx) => {
    if (prodItemIds.length > 0) {
      const piResult = await tx`
        DELETE FROM production_items WHERE id IN ${tx(prodItemIds)}
      `;
      console.log(`  deleted ${piResult.count} production_items`);
    }
    const ciResult = await tx`
      DELETE FROM clip_ideas WHERE id IN ${tx(clipIdeaIds)}
    `;
    console.log(`  deleted ${ciResult.count} clip_ideas`);
  });

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
