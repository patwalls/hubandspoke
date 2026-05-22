#!/usr/bin/env node
/**
 * Seed (or upsert) the "X Quotables" clippable format on a given brand.
 * Authors the format Skill — including the new `## Clip Idea Generation`
 * section that drives the Splice agent and an `extras-schema` for the
 * 3-quotable payload — and ticks `is_clippable_format=true`.
 *
 * Idempotent. Run again to re-publish updated Skill text without dupes.
 *
 * Usage:
 *   Local:        node --env-file=.env.local scripts/seed-x-quotables-format.mjs --apply
 *   Local dry:    node --env-file=.env.local scripts/seed-x-quotables-format.mjs
 *   Heroku:       heroku run --app=hubandspoke "node scripts/seed-x-quotables-format.mjs --apply"
 *
 * Flags:
 *   --apply         Actually write (default: dry run)
 *   --brand=slug    Brand to seed against (default: starter-story)
 *   --name=str      Format name (default: "X Quotables")
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const APPLY_IF_PENDING = args.includes("--apply-if-pending");
const APPLY = args.includes("--apply") || APPLY_IF_PENDING;
const DRY_RUN = !APPLY;
const BRAND = args.find((a) => a.startsWith("--brand="))?.split("=")[1] ?? "starter-story";
const NAME = args.find((a) => a.startsWith("--name="))?.split("=")[1] ?? "X Quotables";

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

// The X Quotables Skill. Sections:
//   - What this format is / Why it works (editorial overview)
//   - Clip guidance + Avoid (Claude / dispatcher reads these)
//   - Clip Idea Generation (Splice agent reads this — hook style, runtime,
//     anti-patterns, extras-schema for the 3-quotable payload)
//   - Descript Clip & Pack Info (Descript Underlord reads this — composition
//     layout, hook overlay, quotables substitution via {{quotables}})
//   - Cross Post Rules (framing + caption guidance for cross-post/repost)
const SKILL = `## What this format is
A tweet anchored to a 25-second horizontal (16:9) video clip from a long-form pillar. The tweet body is a third-person framing line about the speaker; the body of the tweet is 3 verbatim transcript pulls (separated by blank lines) that act as quotables. The clip plays under that body.

## Why it works
Twitter rewards punch + density. The framing line stops the scroll, the 3 quotables prove value before the viewer ever taps play, and the clip closes the loop. Unlike Reels where the hook is a narrator overlay, here the framing line lives in the tweet copy and the speaker delivers the line themselves on video.

## Clip guidance
Pick a section where the speaker delivers 3 discrete punches inside a 20–40s span. Each quotable must be a self-contained sentence — a viewer scanning the tweet should walk away with a usable takeaway from each line on its own. Start on a clean sentence boundary.

## Avoid
First-person hooks ("I'm a founder who…"). Paraphrased quotables. Lines that read as setup for a story the viewer can't hear in the clip. Quotables that span more than one paragraph of dense context — keep each one punchy.

## Clip Idea Generation
**Hook style.** A third-person framing line about the speaker, in the brand's editorial voice. Surface a stance the speaker takes ("Kevin O'Leary says your closet is full of crap and you should start buying quality"). Never use first-person; the speaker is being quoted, not narrating.

**Target runtime.** 20–40 seconds. Tight beats long here — Twitter video gets fewer seconds of attention than Reels.

**Anti-patterns.** First-person hooks; paraphrased quotables; quotables stitched together with ellipses; quotables drawn from outside [startSec, endSec].

**Output extras.** Each idea must include a \`quotables\` array — exactly 3 verbatim transcript pulls, each one paragraph long, each delivering a discrete punch. The 3 quotables should each be inside the clip's [startSec, endSec] range and they should read well as standalone tweets too.

\`\`\`extras-schema
{
  "quotables": {
    "type": "array",
    "items": { "type": "string" },
    "minItems": 3,
    "maxItems": 3,
    "description": "Exactly 3 verbatim transcript pulls, each 1-3 sentences long, each inside [startSec, endSec]. Order them so the most punchy lands first."
  }
}
\`\`\`

## Descript Clip & Pack Info
This is a horizontal 16:9 composition (orientation: \`{{aspectRatio}}\`). No layout pack — the speaker fills the frame with subtitles burned in.

1. Trim to the [{{startTimestamp}}, {{endTimestamp}}] range ({{durationSec}}s total). Do not include footage outside this range.
2. Burn in captions at the bottom-third of the frame, sentence-case, white on transparent. No filler-word stripping — the speaker's natural pacing carries the tweet.
3. No on-screen text overlay or end-card. The tweet body carries the framing — the video is just delivery.

The composition's hook track holds: "{{hook}}".

For reference, the 3 quotables that should land inside the trimmed range:
{{quotables}}

## Cross Post Rules
- This is an X-native format. Cross-posts to other surfaces should use the format's vertical sibling instead.
- For X cross-posts of OTHER formats: use the on-screen hook as the tweet body, verbatim. No thread, no link, no CTA.
`;

console.log(
  `Mode: ${DRY_RUN ? "DRY RUN (use --apply to write)" : "APPLY"}; brand=${BRAND}; name="${NAME}"`,
);

try {
  const existing = await sql`
    SELECT id, name, is_clippable_format, clip_target_post_type, clip_target_platform, clip_aspect_ratio
    FROM formats
    WHERE brand = ${BRAND} AND lower(name) = lower(${NAME})
    LIMIT 1
  `;

  let formatId;
  if (existing.length > 0) {
    const row = existing[0];
    formatId = row.id;
    console.log(`Found existing format id=${row.id} name="${row.name}"`);
    console.log(`  is_clippable_format=${row.is_clippable_format}`);
    console.log(`  clip_target_post_type=${row.clip_target_post_type}`);
    console.log(`  clip_target_platform=${JSON.stringify(row.clip_target_platform)}`);
    console.log(`  clip_aspect_ratio=${row.clip_aspect_ratio}`);
    if (APPLY_IF_PENDING) {
      // Release-phase: format already exists, leave skill + flags alone so
      // operator edits in the UI aren't clobbered on each deploy. Just
      // run the post-create wiring below (format_channels, account
      // backfill) — those are idempotent EXISTS-guarded.
      console.log("Format already exists; skipping field overwrite.");
    } else if (DRY_RUN) {
      console.log("Would UPDATE — re-run with --apply.");
    } else {
      await sql`
        UPDATE formats
        SET
          instructions = ${SKILL},
          is_clippable_format = true,
          clip_target_post_type = 'x',
          clip_target_platform = ${JSON.stringify(["X"])}::jsonb,
          clip_aspect_ratio = '16:9',
          updated_at = NOW()
        WHERE id = ${row.id}
      `;
      console.log(`UPDATED format ${row.id}`);
    }
  } else {
    console.log(`No existing "${NAME}" format on brand ${BRAND}.`);
    if (DRY_RUN) {
      console.log("Would INSERT — re-run with --apply.");
    } else {
      const [inserted] = await sql`
        INSERT INTO formats (
          name, brand, instructions,
          is_clippable_format, clip_target_post_type,
          clip_target_platform, clip_aspect_ratio
        ) VALUES (
          ${NAME}, ${BRAND}, ${SKILL},
          true, 'x',
          ${JSON.stringify(["X"])}::jsonb, '16:9'
        )
        RETURNING id, name
      `;
      formatId = inserted.id;
      console.log(`INSERTED format id=${inserted.id} name="${inserted.name}"`);
    }
  }

  // Wire the format to the brand's canonical (verified) X account via
  // format_channels so clip-idea generation knows which handle to assign.
  // Brands with multiple X handles (Starter Story has @starter_story +
  // @starterstory + @thepatwalls) need this — `findAccountForBrandPlatform`
  // returns null when more than one matches.
  if (formatId) {
    // Prefer the handle that matches the brand slug (with dashes →
    // underscores), then any verified X account, then highest-followers.
    // Brands often have a personal handle (e.g. @thepatwalls) and a brand
    // handle (@starter_story); we want the brand handle here.
    const brandHandleGuess = BRAND.replace(/-/g, "_");
    const [xAccount] = await sql`
      SELECT a.id, a.handle FROM accounts a
      JOIN brands b ON b.id = a.brand_id
      WHERE b.slug = ${BRAND}
        AND a.platform = 'x'
        AND a.deleted_at IS NULL
      ORDER BY
        CASE WHEN lower(a.handle) = lower(${brandHandleGuess}) THEN 0 ELSE 1 END,
        CASE WHEN a.verified = true THEN 0 ELSE 1 END,
        a.follower_count DESC NULLS LAST
      LIMIT 1
    `;
    if (xAccount) {
      const existingFc = await sql`
        SELECT id FROM format_channels
        WHERE format_id = ${formatId} AND account_id = ${xAccount.id}
          AND post_type = 'x'
      `;
      if (existingFc.length === 0) {
        if (DRY_RUN) {
          console.log(`Would INSERT format_channels → @${xAccount.handle}`);
        } else {
          await sql`
            INSERT INTO format_channels (format_id, account_id, post_type)
            VALUES (${formatId}, ${xAccount.id}, 'x')
          `;
          console.log(`Wired format_channels: ${formatId} → @${xAccount.handle} (x)`);
        }
      } else {
        console.log(`format_channels already wired to @${xAccount.handle}`);
      }

      // Backfill: any existing X Quotables productionItems rows still
      // have account_id=NULL. Repair so the triage X-post preview shows
      // the right brand identity.
      if (!DRY_RUN) {
        const backfilled = await sql`
          UPDATE production_items pi
          SET account_id = ${xAccount.id}
          FROM clip_ideas ci
          WHERE pi.source_clip_idea_id = ci.id
            AND ci.target_format = ${NAME}
            AND pi.account_id IS NULL
        `;
        console.log(`Backfilled ${backfilled.count} sibling production_items with account=${xAccount.id}`);
      }
    } else {
      console.log(`No verified X account found for brand ${BRAND} — skipping format_channels wiring.`);
    }
  }
} finally {
  await sql.end();
}
