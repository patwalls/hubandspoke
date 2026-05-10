import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  formats,
  productionItemMedia,
  productionItems,
} from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateDraft,
  GENERATED_BY as AGENT_GENERATED_BY,
  PROMPT_VERSION,
  type MediaAction,
  type MediaContext,
} from "@/lib/draft-agent";
import {
  getSchemaForPostType,
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
import { getMediaRule } from "@/lib/platform-media-rules";
import { addMediaRowsToDraft } from "@/lib/services/draft-media";
import { getTopPerformingCaptions } from "./exemplars";

// The Draft Algorithm — V1.
//
// Generalizes the IG-only `generate-instagram-caption` path. Same Opus 4.7
// agent, same cached preamble, same demote-then-insert tx — but:
//   1. Source-type aware: skips repost (verbatim seed stays) and clip ideas
//      (their copy comes from the clip-idea pipeline). Runs on cross_post
//      and on `original` items that have a pillar (= a repurpose).
//   2. Platform-general: every post type in PLATFORM_FIELD_MAP that's in
//      the V1 supported set gets a draft. Schema is resolved per-postType.
//   3. Exemplars are view-ranked, not recency-ranked. See exemplars.ts.
//
// Bumping `DRAFT_ALGORITHM_VERSION` invalidates audits — use it when the
// branch logic / data assembly changes meaningfully. Prompt-string changes
// belong in `PROMPT_VERSION` on the agent.
//
// V1.1 (2026-05-08): the agent now also picks a `media_action` (attach
// pillar full video / attach pillar poster / none); the service translates
// that into a `production_item_media` row inside the same tx. The
// per-format Skill text is the directive — see draft-agent.ts MEDIA ACTION
// RULES. Idempotent on re-run: if any media row already exists on the
// item, media attachment is skipped (preserves manual edits).
//
// V1.2 (2026-05-09): exemplar selection becomes format-aware. Previously
// the prompt header said "PAST CAPTIONS FOR THIS FORMAT" but the query
// filtered only by (brand, post_type) — so an X repost in "Full Video On
// X!" got the top 8 X tweets across every format on the brand, diluting
// the structural signal that lives at the format level (timestamp
// breakdown, listicle, etc.). The exemplars helper now pulls format-scoped
// winners first and tops up with platform-scoped rows only when a format
// is sparse; the prompt labels each block honestly. See exemplars.ts.
//
// V1.3 (2026-05-09): the algorithm no longer requires a transcript to
// run. Cross-posts from text-primary sources (LinkedIn, X, Threads)
// have nothing to transcribe — the source body IS the substance — but
// V1.2 skipped them with `no_transcript` and produced empty drafts.
// `loadDraftSubstrate` now returns either a transcript (long-form pillar
// derivatives — unchanged path) or the upstream item's contentBody/title
// (text-primary fallback). Skip code renamed to `no_substrate` for the
// genuinely-empty case. Upstream resolution chain expanded from
// `pillarContentItemId ?? item.id` to
// `pillarContentItemId ?? repostedFromItemId ?? item.id` so cross-posts
// actually resolve their source row. See draft-agent.ts for the
// substrate-aware prompt rendering.
//
// V1.4 (2026-05-09): three lifts. (1) Substrate chain now includes the
// `description` column — LinkedIn enrichment routinely populates that
// long-form column with the full post body when SC's short-form fields
// come back empty, and v1.3 walked right past it (echoing the four-word
// title). Chain is now contentBody → description → title. (2) The agent
// gets a "rich substrate" prompt directive when the source body is
// multi-paragraph, telling it to adapt EVERY concrete element rather
// than echo the opener. (3) `MediaContext.itemAlreadyHasMedia` surfaces
// source-mirrored media on cross-posts so the agent picks
// `media_action: "none"` and composes a caption that assumes the images
// are visible.
//
// V1.5 (2026-05-10): the agent gets specialized tools, the first of
// which is `find_interesting_timestamps`. v1.4 handed the agent the
// transcript markdown and asked it to compose copy + scout interesting
// moments + write timestamps in one shot. That conflated editorial
// scouting with copywriting — agents hallucinated mmss values or wrote
// vague ranges. v1.5 splits scouting into a dedicated Opus 4.7
// sub-agent the main agent can call mid-draft. `generateDraft` is now
// a multi-turn loop (max 5 iterations) with `tool_choice: "auto"`; the
// timestamp tool is registered only when substrate.kind === "transcript"
// so cross-posts using source-body substrate single-shot exactly like
// v1.4. Architecture supports adding more tools (find_money_quote,
// find_image_moment) without further plumbing.
export const DRAFT_ALGORITHM_VERSION = "1.5";
export const GENERATED_BY = `draft-algo:v${DRAFT_ALGORITHM_VERSION}:${AGENT_GENERATED_BY}`;

// Translate the agent's MediaAction into a concrete file payload for
// `addMediaRowsToDraft`, or return null if unfulfillable. Two reasons we'd
// return null even when the agent picked something:
//   1. The pillar doesn't have the requested asset (e.g. agent said attach
//      full video but pillar has no archived video).
//   2. The platform rule rejects the kind (e.g. youtube_community is text-
//      only). The prompt also surfaces the rule, so this is belt-and-braces.
function resolveAttachment(
  action: MediaAction,
  pillar: {
    mediaS3Bucket: string | null;
    mediaS3Key: string | null;
    mediaContentType: string | null;
    posterS3Key: string | null;
  },
  rule: ReturnType<typeof getMediaRule>,
): {
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  sizeBytes: number;
  kind: "image" | "video";
  posterS3Key?: string | null;
} | null {
  if (action === "attach_pillar_full_video") {
    if (!pillar.mediaS3Key || !pillar.mediaS3Bucket) return null;
    if (!rule.allowedKinds.includes("video")) return null;
    return {
      s3Bucket: pillar.mediaS3Bucket,
      s3Key: pillar.mediaS3Key,
      contentType: pillar.mediaContentType ?? "video/mp4",
      // sizeBytes is required by AddDraftMediaInput's schema, but we don't
      // re-fetch the S3 HEAD here — the upload-confirm path already
      // populated it on the pillar. 0 is a benign placeholder; consumers
      // that care (UI byte-meter) read the row's stored value, not this.
      sizeBytes: 0,
      kind: "video",
      posterS3Key: pillar.posterS3Key ?? null,
    };
  }
  if (action === "attach_pillar_poster") {
    if (!pillar.posterS3Key || !pillar.mediaS3Bucket) return null;
    if (!rule.allowedKinds.includes("image")) return null;
    return {
      s3Bucket: pillar.mediaS3Bucket,
      s3Key: pillar.posterS3Key,
      // Posters are archived as JPEG by the YouTube enrichment path
      // (services/enrichment/youtube.ts:archiveRemoteToS3).
      contentType: "image/jpeg",
      sizeBytes: 0,
      kind: "image",
    };
  }
  return null;
}

// Platforms the algorithm drafts for in V1. Newsletter + youtube_long are
// out of scope — editors hand-write those today and the leverage isn't
// there yet.
const SUPPORTED_POST_TYPES: ReadonlySet<PostType> = new Set<PostType>([
  "x",
  "linkedin",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
  "tiktok",
  "youtube_community",
  "youtube_shorts",
  "threads",
]);

export type DraftAlgorithmSkipReason =
  | "item_not_found"
  | "repost_kept_verbatim"
  | "pillar_item_no_draft"
  | "unsupported_post_type"
  | "no_platform_schema"
  | "no_caption_field"
  | "already_filled"
  // No transcript AND no source body/title to draft from. Renamed in v1.3
  // from `no_transcript` — the algorithm now also accepts source post text
  // as a substrate, so a missing transcript alone no longer skips.
  | "no_substrate";

export interface RunDraftAlgorithmResult {
  status: "generated" | "skipped";
  reason?: DraftAlgorithmSkipReason;
  draftId?: string;
  /** What the agent wrote into the primary caption field — handy for the
   *  manual endpoint to surface in its response without an extra DB read. */
  captionPreview?: string;
}

export interface RunDraftAlgorithmOpts {
  /** Override the "already-filled" idempotency guard. Set when an editor
   *  explicitly clicks Regenerate on a draft that already has content. */
  force?: boolean;
  actorUserId?: string | null;
}

/**
 * V1.4: resolve the substrate the agent will draft from. Tries in order:
 *   1. The upstream's transcript (long-form pillar derivatives — usual path).
 *   2. The upstream's contentBody (text-primary cross-posts: tweet body,
 *      IG caption — what the SC enrichers normally populate).
 *   3. The upstream's `description` long-form column (LinkedIn share posts:
 *      SC returns the multi-paragraph body under `data.description` and the
 *      LinkedIn enricher writes it here, NOT into contentBody. v1.3 missed
 *      this column entirely and ended up echoing the four-word title
 *      because that was the only non-empty field in its chain).
 *   4. The upstream's title (last fallback when SC came up empty on body
 *      and description — common for one-line tweets).
 *   5. The item's own contentBody/description/title (covers an exotic case
 *      where seed copied the source body but no `repostedFromItemId` was set).
 *
 * Upstream chain is `pillarContentItemId ?? repostedFromItemId ?? item.id`,
 * so cross-posts (which set `repostedFromItemId` but not pillar) actually
 * resolve their source — V1.2 always fell back to `item.id` for those,
 * which is the just-created empty new row.
 *
 * Returns null only when nothing resolves; the algorithm then skips with
 * `no_substrate`.
 */
async function loadDraftSubstrate(item: {
  id: string;
  title: string | null;
  contentBody: string | null;
  description: string | null;
  pillarContentItemId: string | null;
  repostedFromItemId: string | null;
}): Promise<
  | {
      kind: "transcript";
      segmentsMarkdown: string;
      durationSec: number;
      segments: ReadonlyArray<{
        startSec: number;
        endSec: number;
        text: string;
        speaker?: string;
      }>;
    }
  | { kind: "source_body"; text: string; sourcePostType: string | null }
  | null
> {
  const upstreamId =
    item.pillarContentItemId ?? item.repostedFromItemId ?? item.id;

  const transcript = await getTranscriptForPrompt(upstreamId);
  if (transcript) {
    return {
      kind: "transcript",
      segmentsMarkdown: transcript.segmentsMarkdown,
      durationSec: transcript.durationSec,
      // v1.5: surface the raw segments[] so the find_interesting_timestamps
      // tool can ground its picks in real segment text (not just the
      // rendered markdown). Tool implementation in
      // src/lib/services/draft-algorithm/timestamp-finder.ts.
      segments: transcript.segments,
    };
  }

  // No transcript on the upstream. For cross-posts (and the rare
  // self-pointing case) fall back to the upstream's body / description /
  // title. Description ranks ABOVE title because LinkedIn enrichment
  // routinely populates description with the full post body when SC
  // doesn't surface text/bodyText/postBody/headline.
  if (upstreamId !== item.id) {
    const [upstream] = await db
      .select({
        contentBody: productionItems.contentBody,
        description: productionItems.description,
        title: productionItems.title,
        postType: productionItems.postType,
      })
      .from(productionItems)
      .where(eq(productionItems.id, upstreamId))
      .limit(1);
    const body = upstream?.contentBody?.trim();
    if (body && body.length > 0) {
      return {
        kind: "source_body",
        text: body,
        sourcePostType: upstream?.postType ?? null,
      };
    }
    const description = upstream?.description?.trim();
    if (description && description.length > 0) {
      return {
        kind: "source_body",
        text: description,
        sourcePostType: upstream?.postType ?? null,
      };
    }
    const title = upstream?.title?.trim();
    if (title && title.length > 0) {
      return {
        kind: "source_body",
        text: title,
        sourcePostType: upstream?.postType ?? null,
      };
    }
  }

  // Last-ditch: maybe the seed copied the source body onto the new
  // item's own contentBody / description / title before this ran.
  // Almost never the right path but cheaper to read than to skip and
  // confuse the editor.
  const ownBody = item.contentBody?.trim();
  if (ownBody && ownBody.length > 0) {
    return { kind: "source_body", text: ownBody, sourcePostType: null };
  }
  const ownDescription = item.description?.trim();
  if (ownDescription && ownDescription.length > 0) {
    return { kind: "source_body", text: ownDescription, sourcePostType: null };
  }
  const ownTitle = item.title?.trim();
  if (ownTitle && ownTitle.length > 0) {
    return { kind: "source_body", text: ownTitle, sourcePostType: null };
  }

  return null;
}

/**
 * Run the Draft Algorithm against a production item.
 *
 * Idempotent on retry: skips with `already_filled` when a non-seeded
 * caption is already present and `force` is false. The auto-fire path
 * (cross-post + repurpose routes) fires-and-forgets after item creation,
 * so a retry must never clobber editor edits.
 */
export async function runDraftAlgorithm(
  productionItemId: string,
  opts: RunDraftAlgorithmOpts = {},
): Promise<RunDraftAlgorithmResult> {
  const { force = false, actorUserId = null } = opts;

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) return { status: "skipped", reason: "item_not_found" };

  // Source-type branch. The algorithm fires on items that need a new
  // first draft grounded in the pillar transcript + view-ranked exemplars.
  // Repost is the one explicit skip — same content, same platform, the
  // seed already copied the source caption verbatim.
  //
  // The full enum (see schema.ts:222 + comment): `original` (pillar OR
  // manually-created repurpose, the default), `repost`, `cross_post`,
  // `clip` (promoted from clip-idea), `repurposed` (auto-created by the
  // threshold-monitor-sweep cron). Both repurpose paths land here as
  // "draft me" — the manual route uses the `original` default + sets
  // `pillarContentItemId`, the cron writes `repurposed` explicitly.
  switch (item.sourceType) {
    case "repost":
      return { status: "skipped", reason: "repost_kept_verbatim" };
    case "original":
      // `original` is two cases:
      //   - Pillar items (no parent) — these ARE the source. Long-form,
      //     editors hand-write the copy.
      //   - Manually-created repurpose items (pillarContentItemId set) —
      //     fall through.
      if (!item.pillarContentItemId) {
        return { status: "skipped", reason: "pillar_item_no_draft" };
      }
      break;
    case "cross_post":
    case "clip":
    case "repurposed":
      // cross_post: different platform than the source; pillar transcript
      //   is the right grounding.
      // clip: paired to a clip_idea (which sets hook + angle metadata),
      //   but the post-side caption still needs drafting — same as IG had
      //   under the old path.
      // repurposed: cron-created derivative of a pillar; same shape as
      //   the manual repurpose path, just a different `sourceType` label.
      break;
    default:
      return { status: "skipped", reason: "pillar_item_no_draft" };
  }

  if (!item.postType || !SUPPORTED_POST_TYPES.has(item.postType as PostType)) {
    return { status: "skipped", reason: "unsupported_post_type" };
  }

  const fieldSchema = getSchemaForPostType(item.postType);
  if (!fieldSchema) return { status: "skipped", reason: "no_platform_schema" };

  const captionFieldKey =
    PLATFORM_FIELD_MAP[item.postType as PostType]?.caption ?? null;
  if (!captionFieldKey) return { status: "skipped", reason: "no_caption_field" };

  // Idempotency guard. The auto-fire path runs right after seedRepostContent
  // (cross-post) writes the source's contentBody into the draft, so the
  // primary caption field is already non-empty — but it's just the source
  // body. We distinguish via `generatedBy`: "copy:source" means seed
  // (overwrite welcome); anything else (incl. "user", a prior draft-algo
  // run) means a human or agent has touched it (don't clobber unless
  // forced). Repurpose has no draft yet so this branch is harmless there.
  const [currentDraft] = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, productionItemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);

  if (!force && currentDraft) {
    const existingCaption = (currentDraft.content as Record<string, unknown> | null)?.[
      captionFieldKey
    ];
    const isSeededCopy = currentDraft.generatedBy === "copy:source";
    const hasMeaningfulCaption =
      typeof existingCaption === "string" && existingCaption.trim().length > 0;
    if (hasMeaningfulCaption && !isSeededCopy) {
      return { status: "skipped", reason: "already_filled" };
    }
  }

  // V1.4 substrate resolution. Long-form pillar derivatives prefer the
  // pillar transcript (timestamps + segment text); cross-posts whose
  // source is text-primary fall back to the upstream's contentBody,
  // then `description` (LinkedIn long-form bodies live here), then
  // title. Skip with `no_substrate` only when nothing resolves.
  const substrate = await loadDraftSubstrate(item);
  if (!substrate) return { status: "skipped", reason: "no_substrate" };

  // Format instructions (editorial voice / style guide). Optional.
  let formatInstructions: string | null = null;
  if (item.format) {
    const [fmt] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
      .limit(1);
    formatInstructions = fmt?.instructions ?? null;
  }

  // Past captions, view-ranked. v1.2: format-scoped first, with a
  // platform-scoped top-up when the format is sparse (see exemplars.ts).
  // Format is the strongest structural signal — same-format winners
  // share opening shape, list patterns, timestamp breakdowns, etc.
  const pastCaptions = await getTopPerformingCaptions({
    brand: item.brand,
    postType: item.postType,
    format: item.format ?? null,
    excludeId: productionItemId,
  });

  // Pillar title + media for context when this is a derivative. The media
  // metadata (S3 keys + poster) drives the V1.1 MediaContext: the agent
  // sees what's available, picks an action, and we attach in the tx below.
  let pillarTitle: string | null = item.title;
  let pillar: {
    id: string;
    mediaS3Bucket: string | null;
    mediaS3Key: string | null;
    mediaContentType: string | null;
    posterS3Key: string | null;
  } | null = null;
  if (item.pillarContentItemId) {
    const [row] = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        mediaS3Bucket: productionItems.mediaS3Bucket,
        mediaS3Key: productionItems.mediaS3Key,
        mediaContentType: productionItems.mediaContentType,
        posterS3Key: productionItems.posterS3Key,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (row) {
      pillarTitle = row.title;
      pillar = {
        id: row.id,
        mediaS3Bucket: row.mediaS3Bucket,
        mediaS3Key: row.mediaS3Key,
        mediaContentType: row.mediaContentType,
        posterS3Key: row.posterS3Key,
      };
    }
  }

  const platformArr = (item.platform as string[] | null) ?? [item.postType];

  // V1.4: count media rows already on the item itself. For cross-posts
  // `seedRepostContent` mirrors the source's `productionItemMedia` rows
  // onto the new row before the algorithm fires, so the agent should
  // know the post will publish with N images already attached and pick
  // `media_action: "none"` rather than try to attach pillar media on
  // top. The query is a single WHERE-by-id read; cheap.
  const existingMediaRows = await db
    .select({ kind: productionItemMedia.kind })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, productionItemId));
  const itemAlreadyHasMedia = {
    count: existingMediaRows.length,
    kinds: Array.from(
      new Set(
        existingMediaRows
          .map((r) => r.kind)
          .filter((k): k is "image" | "video" => k === "image" || k === "video"),
      ),
    ),
  };

  // Build the MediaContext for the agent. Tells it what pillar media is
  // archived, what the target platform's media rule allows, and whether
  // media rows are ALREADY on this item from a source seed.
  const mediaRule = getMediaRule(item.postType);
  const mediaContext: MediaContext = {
    pillarHasFullVideo: !!pillar?.mediaS3Key,
    pillarHasPoster: !!pillar?.posterS3Key,
    platformMode: mediaRule.mode,
    platformAllowedKinds: mediaRule.allowedKinds,
    itemAlreadyHasMedia,
  };

  const result = await generateDraft({
    item: {
      id: item.id,
      title: item.title,
      format: item.format,
      platform: platformArr,
      brand: item.brand,
    },
    fieldSchema,
    formatInstructions,
    pillarTitle,
    substrate,
    pastCaptions,
    mediaContext,
  });

  // Demote previous current + insert new current as version+1 in a tx —
  // keeps the partial unique index on (production_item_id) WHERE is_current
  // happy. Works for first insert too (prevCurrent is undefined → version 1).
  const inserted = await db.transaction(async (tx) => {
    const [prevCurrent] = await tx
      .select({ version: contentDrafts.version })
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, productionItemId))
      .orderBy(desc(contentDrafts.version))
      .limit(1);
    const nextVersion = (prevCurrent?.version ?? 0) + 1;

    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(
        and(
          eq(contentDrafts.productionItemId, productionItemId),
          eq(contentDrafts.isCurrent, true),
        ),
      );

    const [row] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId,
        version: nextVersion,
        isCurrent: true,
        content: result.content,
        fieldSchemaSnapshot: fieldSchema,
        generatedBy: GENERATED_BY,
        promptVersion: PROMPT_VERSION,
        modelUsage: result.modelUsage,
        createdByUserId: actorUserId,
      })
      .returning();

    // V1.1 media attachment. Only attach when:
    //   1. Agent picked an actionable action (not "none").
    //   2. Item has zero existing media rows — preserves manual edits and
    //      makes Redraft idempotent (re-runs don't churn media).
    //   3. The action is fulfillable: pillar has the requested asset AND
    //      the platform rule accepts the implied kind. Belt-and-braces with
    //      the prompt — if the model misjudges, we silently skip here.
    if (result.mediaAction !== "none" && pillar) {
      const [hasMedia] = await tx
        .select({ id: productionItemMedia.id })
        .from(productionItemMedia)
        .where(eq(productionItemMedia.productionItemId, productionItemId))
        .limit(1);
      if (!hasMedia) {
        const file = resolveAttachment(result.mediaAction, pillar, mediaRule);
        if (file) {
          await addMediaRowsToDraft(tx, {
            itemId: productionItemId,
            files: [file],
          });
          // Mirror to the legacy single-media columns on production_items
          // (the index-0 carousel row is the source of truth; legacy
          // columns are a derived cache that other writers — enrichment,
          // seedRepostContent, the media route — keep in sync).
          await tx
            .update(productionItems)
            .set({
              mediaS3Bucket: file.s3Bucket,
              mediaS3Key: file.s3Key,
              mediaContentType: file.contentType,
              posterS3Key: file.posterS3Key ?? null,
            })
            .where(eq(productionItems.id, productionItemId));
        }
      }
    }

    return row;
  });

  const generatedCaption = (result.content as Record<string, unknown>)[captionFieldKey];

  return {
    status: "generated",
    draftId: inserted.id,
    captionPreview:
      typeof generatedCaption === "string" ? generatedCaption : undefined,
  };
}
