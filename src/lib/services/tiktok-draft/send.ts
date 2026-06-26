// TikTok draft-to-inbox sender + guardrails. Single source of truth for
// "deliver this item's video to the creator's TikTok inbox via Zernio".
// Called by BOTH the route (immediate send) and the scheduled task, so every
// guardrail lives here exactly once.
//
// Safety is the whole point: Pat is anxious about posting the wrong thing.
// Every feared failure (wrong video, missing caption, slideshow posting only
// slide 1, double-post) is a hard block here, re-validated against a fresh DB
// read at send time — never trusting what a client cached.

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  contentDrafts,
  productionItems,
  productionItemMedia,
} from "@/lib/db/schema";
import { getMediaRule } from "@/lib/platform-media-rules";
import { getPresignedGetUrl, headObject } from "@/lib/s3";
import {
  createTikTokPost,
  getAccountPosts,
  getPost,
  getTikTokCreatorInfo,
  tikTokTarget,
  type TikTokPrivacyLevel,
} from "@/lib/zernio";
import { recordToolAction } from "@/lib/services/content-events";
import { enqueue } from "@/jobs/enqueue";

const DEFAULT_PRIVACY = "PUBLIC_TO_EVERYONE";

function normalizeForMatch(s: string | null | undefined): string {
  // Strip everything but letters/digits for an identity comparison between our
  // caption and the platform's (often truncated) post message. Structural, not
  // semantic — we're matching our OWN known post, not interpreting meaning.
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve the REAL live URL of a just-published post by looking it up in the
 * account's actual post feed (`getAccountPosts`). This is the only reliable
 * source: TikTok's Content Posting API returns a publish id, not the video id
 * or URL, so constructing a URL from it is wrong. We match by recency (the
 * post we just made is the newest) with a caption-prefix tiebreaker, and
 * return the clean permalink. Returns null until the post shows up in the feed
 * (a few seconds after publish) — the caller keeps polling.
 */
async function resolvePublishedUrl(
  zernioAccountId: string | null,
  caption: string,
  sentAt: Date | null,
): Promise<string | null> {
  if (!zernioAccountId) return null;
  let posts;
  try {
    posts = await getAccountPosts(zernioAccountId);
  } catch {
    return null;
  }
  if (!posts.length) return null;

  // Only consider posts created around/after we sent it (2-min grace for clock
  // skew + processing). Without a sentAt, consider the whole recent feed.
  const floor = sentAt ? sentAt.getTime() - 2 * 60 * 1000 : 0;
  const recent = posts.filter(
    (p) =>
      p.permalink &&
      (!sentAt ||
        (p.createdTime && new Date(p.createdTime).getTime() >= floor)),
  );
  if (!recent.length) return null;

  const capKey = normalizeForMatch(caption).slice(0, 24);
  const byCaption =
    capKey.length >= 8
      ? recent.find((p) =>
          normalizeForMatch(p.message).startsWith(capKey.slice(0, 16)),
        )
      : null;
  const chosen =
    byCaption ??
    recent
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdTime ?? 0).getTime() -
          new Date(a.createdTime ?? 0).getTime(),
      )[0];

  // Strip tracking query params for a clean canonical link.
  return chosen?.permalink ? chosen.permalink.split("?")[0] : null;
}

/** Conservative video size ceiling. Docs conflict (287.6 MB vs 4 GB); 287 MB
 *  matches TikTok's own direct-post limit, so treat it as the safe warn
 *  threshold until verified live. Warn-only — don't reject valid posts. */
const SIZE_WARN_BYTES = 287 * 1024 * 1024;
/** TikTok's third-party-API per-account cap. We warn pre-emptively; Zernio's
 *  real 429 is the authority. */
const CAP_PER_24H = 25;
/** TTL for the presigned video URL handed to Zernio. Generous so it stays
 *  valid through Zernio's async media fetch; minted at send time, never
 *  persisted. */
const PRESIGN_TTL_SECONDS = 6 * 60 * 60;

export type TikTokDraftBlockCode =
  | "not_tiktok"
  | "no_media"
  | "multiple_media"
  | "not_video"
  | "media_missing"
  | "no_caption"
  | "not_connected"
  | "already_sent"
  | "media_changed"
  | "caption_changed"
  | "claim_lost";

export interface TikTokDraftBlock {
  code: TikTokDraftBlockCode;
  message: string;
}

export type TikTokDraftWarningCode = "size" | "cap";

export interface TikTokDraftWarning {
  code: TikTokDraftWarningCode;
  message: string;
}

/** Thrown by `sendTikTokDraft` when a hard guardrail blocks the send. The
 *  route maps `.block.code` to an HTTP status (409 for already_sent /
 *  claim_lost, 422 for the rest). */
export class TikTokDraftError extends Error {
  block: TikTokDraftBlock;
  constructor(block: TikTokDraftBlock) {
    super(block.message);
    this.name = "TikTokDraftError";
    this.block = block;
  }
}

export interface DraftContext {
  itemId: string;
  postType: string | null;
  accountId: string | null;
  zernioPostId: string | null;
  zernioStatus: string | null;
  editorUserId: string | null;
  accountPlatform: string | null;
  accountHandle: string | null;
  zernioAccountId: string | null;
  /** The single media row (index 0) if exactly one exists; otherwise null. */
  mediaId: string | null;
  mediaCount: number;
  mediaKind: string | null;
  mediaS3Key: string | null;
  mediaContentType: string | null;
  mediaPosterS3Key: string | null;
  mediaSizeBytes: number | null;
  caption: string;
  capUsed24h: number;
}

/**
 * Gather everything the guardrails need in one pass. CRITICAL: media is read
 * from `production_item_media` (the carousel rows), NOT the legacy
 * `mediaS3Key` mirror — the mirror only reflects index 0, so a 5-slide
 * carousel would silently pass a "one video" check. This is Pat's #1 fear.
 */
async function gatherContext(itemId: string): Promise<DraftContext> {
  const [item] = await db
    .select({
      id: productionItems.id,
      postType: productionItems.postType,
      accountId: productionItems.accountId,
      zernioPostId: productionItems.zernioPostId,
      zernioStatus: productionItems.zernioStatus,
      editorUserId: productionItems.editorUserId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) {
    throw new TikTokDraftError({
      code: "no_media",
      message: "Item not found.",
    });
  }

  // Media from the carousel table, ordered — count rows, never trust the mirror.
  const mediaRows = await db
    .select({
      id: productionItemMedia.id,
      kind: productionItemMedia.kind,
      s3Key: productionItemMedia.s3Key,
      contentType: productionItemMedia.contentType,
      posterS3Key: productionItemMedia.posterS3Key,
      sizeBytes: productionItemMedia.sizeBytes,
    })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, itemId))
    .orderBy(productionItemMedia.index);

  const single = mediaRows.length === 1 ? mediaRows[0] : null;

  // Account connection state.
  let accountPlatform: string | null = null;
  let accountHandle: string | null = null;
  let zernioAccountId: string | null = null;
  if (item.accountId) {
    const [acct] = await db
      .select({
        platform: accounts.platform,
        handle: accounts.handle,
        zernioAccountId: accounts.zernioAccountId,
      })
      .from(accounts)
      .where(eq(accounts.id, item.accountId))
      .limit(1);
    accountPlatform = acct?.platform ?? null;
    accountHandle = acct?.handle ?? null;
    zernioAccountId = acct?.zernioAccountId ?? null;
  }

  // Current caption from the live draft. TikTok caption is a plain string.
  const [draft] = await db
    .select({ content: contentDrafts.content })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, itemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);
  const captionRaw = draft?.content?.caption;
  const caption = typeof captionRaw === "string" ? captionRaw.trim() : "";

  // 24h cap usage for this account (our own successful sends).
  let capUsed24h = 0;
  if (item.accountId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.accountId, item.accountId),
          isNotNull(productionItems.zernioSentAt),
          gte(productionItems.zernioSentAt, since),
        ),
      );
    capUsed24h = n ?? 0;
  }

  return {
    itemId: item.id,
    postType: item.postType,
    accountId: item.accountId,
    zernioPostId: item.zernioPostId,
    zernioStatus: item.zernioStatus,
    editorUserId: item.editorUserId,
    accountPlatform,
    accountHandle,
    zernioAccountId,
    mediaId: single?.id ?? null,
    mediaCount: mediaRows.length,
    mediaKind: single?.kind ?? null,
    mediaS3Key: single?.s3Key ?? null,
    mediaContentType: single?.contentType ?? null,
    mediaPosterS3Key: single?.posterS3Key ?? null,
    mediaSizeBytes: single?.sizeBytes ?? null,
    caption,
    capUsed24h,
  };
}

export interface ValidateOpts {
  /** When true (the scheduled task), a `scheduled` zernioStatus is the
   *  expected starting state, not an already-sent blocker. */
  fromScheduledTask?: boolean;
  /** Staleness guards: if provided and the current value differs, block. */
  expectedMediaId?: string | null;
  expectedCaption?: string | null;
}

/** Pure guardrail evaluation over a gathered context. Returns blocks +
 *  warnings; mutates nothing. The `media_missing` check needs an async S3
 *  head, so it's added by the caller — see `validateWithS3`. */
export function evaluateGuardrails(
  ctx: DraftContext,
  opts: ValidateOpts,
): { blocks: TikTokDraftBlock[]; warnings: TikTokDraftWarning[] } {
  const blocks: TikTokDraftBlock[] = [];
  const warnings: TikTokDraftWarning[] = [];

  // postType must be exactly tiktok (not another single-video type that
  // happens to share the media mode).
  if (ctx.postType !== "tiktok") {
    blocks.push({
      code: "not_tiktok",
      message: "Only TikTok items can be sent to the TikTok inbox.",
    });
  } else if (getMediaRule("tiktok").mode !== "single-video") {
    // Defensive: if the media rule ever changes, fail closed.
    blocks.push({
      code: "not_video",
      message: "TikTok is not configured for single-video posting.",
    });
  }

  // Media shape — the slideshow guard. Exactly one video.
  if (ctx.mediaCount === 0) {
    blocks.push({
      code: "no_media",
      message: "This item has no video attached yet.",
    });
  } else if (ctx.mediaCount > 1) {
    blocks.push({
      code: "multiple_media",
      message: `This item has ${ctx.mediaCount} media items. TikTok video posting needs exactly one video — slideshows aren't supported yet.`,
    });
  } else {
    const isVideo =
      ctx.mediaKind === "video" &&
      (ctx.mediaContentType?.startsWith("video/") ?? false);
    if (!isVideo) {
      blocks.push({
        code: "not_video",
        message: "The attached media isn't a video.",
      });
    }
  }

  // Caption present — the human pastes it in-app (TikTok won't carry it), so
  // an empty caption means they'd have nothing to paste.
  if (!ctx.caption) {
    blocks.push({
      code: "no_caption",
      message: "Write a caption first — TikTok won't carry it into the draft, so you'll paste it when finishing the post.",
    });
  }

  // Account connected to Zernio.
  if (ctx.accountPlatform !== "tiktok" || !ctx.zernioAccountId) {
    blocks.push({
      code: "not_connected",
      message: "This account isn't connected to TikTok. Connect it on the Accounts page first.",
    });
  }

  // Idempotency / already-sent.
  const hardSent =
    ctx.zernioPostId != null ||
    ctx.zernioStatus === "sending" ||
    ctx.zernioStatus === "publishing" ||
    ctx.zernioStatus === "published" ||
    ctx.zernioStatus === "delivered";
  const scheduledBlocks =
    !opts.fromScheduledTask && ctx.zernioStatus === "scheduled";
  if (hardSent || scheduledBlocks) {
    blocks.push({
      code: "already_sent",
      message:
        ctx.zernioStatus === "scheduled"
          ? "This item is already scheduled to publish. Cancel the schedule first to publish now."
          : "This item has already been published to TikTok (or is in flight).",
    });
  }

  // Staleness — content changed between preview and confirm.
  if (
    opts.expectedMediaId !== undefined &&
    opts.expectedMediaId !== null &&
    ctx.mediaId !== opts.expectedMediaId
  ) {
    blocks.push({
      code: "media_changed",
      message: "The video changed since you opened this dialog. Re-check the preview before sending.",
    });
  }
  if (
    opts.expectedCaption !== undefined &&
    opts.expectedCaption !== null &&
    ctx.caption !== opts.expectedCaption.trim()
  ) {
    blocks.push({
      code: "caption_changed",
      message: "The caption changed since you opened this dialog. Re-check the preview before sending.",
    });
  }

  // Warnings (non-blocking).
  if (ctx.mediaSizeBytes != null && ctx.mediaSizeBytes > SIZE_WARN_BYTES) {
    warnings.push({
      code: "size",
      message: `Video is ${(ctx.mediaSizeBytes / (1024 * 1024)).toFixed(0)} MB — TikTok may reject files over ~287 MB.`,
    });
  }
  if (ctx.capUsed24h >= CAP_PER_24H) {
    warnings.push({
      code: "cap",
      message: `You've sent ${ctx.capUsed24h} TikTok drafts in the last 24h. TikTok caps API posts at ${CAP_PER_24H}/24h — this one may be rejected.`,
    });
  } else if (ctx.capUsed24h >= CAP_PER_24H - 3) {
    warnings.push({
      code: "cap",
      message: `You've sent ${ctx.capUsed24h} of ${CAP_PER_24H} allowed TikTok drafts in the last 24h.`,
    });
  }

  return { blocks, warnings };
}

export interface TikTokDraftPreview {
  itemId: string;
  caption: string;
  videoPosterUrl: string | null;
  /** Presigned URL to the actual video — so the dialog can play exactly what
   *  ships, beside the caption. */
  videoUrl: string | null;
  mediaCount: number;
  mediaId: string | null;
  videoSizeBytes: number | null;
  accountConnected: boolean;
  /** Allowed TikTok privacy levels for this creator (Public / Friends /
   *  Only-me), from creator-info. Empty when not connected. */
  privacyLevels: TikTokPrivacyLevel[];
  zernioStatus: string | null;
  zernioPostId: string | null;
  capUsed24h: number;
  capRemaining: number;
  blockingReasons: TikTokDraftBlock[];
  warnings: TikTokDraftWarning[];
}

/**
 * Read-only preview for the confirm dialog AND the post-send banner. The send
 * re-derives the exact same context server-side, so what the dialog shows is
 * what gets sent ("preview = source of truth").
 */
export async function buildTikTokDraftPreview(
  itemId: string,
): Promise<TikTokDraftPreview> {
  const ctx = await gatherContext(itemId);
  const { blocks, warnings } = evaluateGuardrails(ctx, {});

  let videoPosterUrl: string | null = null;
  const posterKey = ctx.mediaPosterS3Key;
  if (posterKey) {
    try {
      videoPosterUrl = await getPresignedGetUrl(posterKey, 60 * 60);
    } catch {
      videoPosterUrl = null;
    }
  }

  let videoUrl: string | null = null;
  if (ctx.mediaS3Key && ctx.mediaKind === "video") {
    try {
      videoUrl = await getPresignedGetUrl(ctx.mediaS3Key, 60 * 60);
    } catch {
      videoUrl = null;
    }
  }

  const accountConnected =
    ctx.accountPlatform === "tiktok" && !!ctx.zernioAccountId;

  // Allowed privacy levels come from the live creator-info — fail soft to a
  // Public default so the dialog still works if the call hiccups.
  let privacyLevels: TikTokPrivacyLevel[] = [];
  if (accountConnected && ctx.zernioAccountId) {
    try {
      privacyLevels = (await getTikTokCreatorInfo(ctx.zernioAccountId))
        .privacyLevels;
    } catch {
      privacyLevels = [
        { value: DEFAULT_PRIVACY, label: "Public To Everyone" },
      ];
    }
  }

  return {
    itemId: ctx.itemId,
    caption: ctx.caption,
    videoPosterUrl,
    videoUrl,
    mediaCount: ctx.mediaCount,
    mediaId: ctx.mediaId,
    videoSizeBytes: ctx.mediaSizeBytes,
    accountConnected,
    privacyLevels,
    zernioStatus: ctx.zernioStatus,
    zernioPostId: ctx.zernioPostId,
    capUsed24h: ctx.capUsed24h,
    capRemaining: Math.max(0, CAP_PER_24H - ctx.capUsed24h),
    blockingReasons: blocks,
    warnings,
  };
}

export interface SendTikTokDraftOpts {
  actorUserId: string | null;
  fromScheduledTask?: boolean;
  expectedMediaId?: string | null;
  expectedCaption?: string | null;
  /** TikTok privacy level for the live post. Defaults to public. */
  privacyLevel?: string;
}

export interface SendTikTokDraftResult {
  zernioPostId: string;
  caption: string;
  published: boolean;
  liveUrl: string | null;
}

/**
 * Deliver the item's video to the creator's TikTok inbox as a draft.
 * Throws `TikTokDraftError` on any hard guardrail block (nothing is mutated).
 * On success, stamps `zernioPostId` + `zernioStatus='delivered'` and records
 * the activity-feed action.
 *
 * Flow: gather → validate → S3 head → atomic claim → mint presigned URL →
 * Zernio create → stamp delivered (immediately after 2xx to minimize the
 * at-least-once window).
 */
export async function sendTikTokDraft(
  itemId: string,
  opts: SendTikTokDraftOpts,
): Promise<SendTikTokDraftResult> {
  const ctx = await gatherContext(itemId);
  const { blocks } = evaluateGuardrails(ctx, {
    fromScheduledTask: opts.fromScheduledTask,
    expectedMediaId: opts.expectedMediaId,
    expectedCaption: opts.expectedCaption,
  });
  if (blocks.length > 0) {
    throw new TikTokDraftError(blocks[0]);
  }

  // The S3 object must actually exist — catches "media row in DB but object
  // deleted/never uploaded" before we hand Zernio a URL that 404s.
  const head = ctx.mediaS3Key ? await headObject(ctx.mediaS3Key) : null;
  if (!head) {
    throw new TikTokDraftError({
      code: "media_missing",
      message: "The video file is missing from storage. Re-upload it and try again.",
    });
  }

  // Atomic claim: flip to 'sending' iff not already owned/delivered. This is
  // the real mutex against double-clicks and job retries. Allows
  // null/failed/scheduled → sending (the scheduled task transitions from
  // 'scheduled'); blocks 'sending'/'delivered'/already-has-postId.
  const claimed = await db
    .update(productionItems)
    .set({ zernioStatus: "sending", zernioError: null, updatedAt: new Date() })
    .where(
      and(
        eq(productionItems.id, itemId),
        sql`${productionItems.zernioPostId} is null`,
        sql`${productionItems.zernioStatus} is distinct from 'sending'`,
        sql`${productionItems.zernioStatus} is distinct from 'publishing'`,
        sql`${productionItems.zernioStatus} is distinct from 'published'`,
        sql`${productionItems.zernioStatus} is distinct from 'delivered'`,
      ),
    )
    .returning({ id: productionItems.id });

  if (claimed.length === 0) {
    throw new TikTokDraftError({
      code: "claim_lost",
      message: "This item is already being sent (or was just sent). Refresh to see its status.",
    });
  }

  try {
    // Mint the presigned URL HERE, immediately before the call — never
    // persisted, never passed through a job payload.
    const videoUrl = await getPresignedGetUrl(
      ctx.mediaS3Key!,
      PRESIGN_TTL_SECONDS,
    );

    const post = await createTikTokPost({
      accountId: ctx.zernioAccountId!,
      videoUrl,
      caption: ctx.caption,
      privacyLevel: opts.privacyLevel ?? DEFAULT_PRIVACY,
    });

    // Inspect the per-TikTok delivery target. An immediate "failed" on the
    // synchronous response is a hard failure; otherwise it's accepted (live or
    // still publishing — Zernio finishes async and the webhook confirms).
    const target = tikTokTarget(post);
    if (target?.status === "failed") {
      throw new Error(target.errorMessage || "TikTok rejected the post");
    }
    // The just-published post usually isn't in the account feed yet (TikTok
    // takes a few seconds), so this is typically null at create time → we go
    // to 'publishing' and the poll picks up the real URL.
    const liveUrl =
      target?.status === "published"
        ? await resolvePublishedUrl(ctx.zernioAccountId, ctx.caption, new Date())
        : null;
    // "Settled" means live AND we have the real link. Don't settle a live post
    // without its link (the bug Pat hit) — keep polling until it appears.
    const settled = target?.status === "published" && !!liveUrl;

    // Stamp immediately after the 2xx (no slow work between) to minimize the
    // window where a crash could lose the postId and cause a retry double-post.
    const set: Record<string, unknown> = {
      zernioPostId: post._id,
      zernioStatus: settled ? "published" : "publishing",
      zernioSentAt: new Date(),
      zernioScheduledAt: null,
      zernioError: null,
      updatedAt: new Date(),
    };
    // Flip to Published only WITH the link, so the publish pipeline never sees
    // a Published-but-linkless item.
    if (settled) {
      set.publishedLink = liveUrl;
      set.status = "Published";
      set.publishedAt = new Date();
    }
    await db
      .update(productionItems)
      .set(set)
      .where(eq(productionItems.id, itemId));

    await recordToolAction({
      contentItemId: itemId,
      userId: opts.actorUserId,
      tool: "zernio",
      action: "published",
      status: "success",
      label: settled ? "Published to TikTok" : "Publishing to TikTok…",
      url: liveUrl,
      meta: { zernioPostId: post._id },
    });

    // Not fully settled (still publishing, or live but link not assigned yet)
    // → schedule a worker poll as the closed-tab fallback (the page banner also
    // polls client-side). Both run the same idempotent reconcile, so racing is
    // harmless. Best-effort: a failed enqueue (e.g. no worker locally) must not
    // fail the publish.
    if (!settled) {
      try {
        await enqueue(
          "zernio-poll-publish",
          { productionItemId: itemId, deadlineAt: Date.now() + 5 * 60 * 1000 },
          { jobKey: `zernio-poll:${itemId}`, jobKeyMode: "replace" },
        );
      } catch {
        // ignore — client poll covers the watching-user case
      }
    }

    return { zernioPostId: post._id, caption: ctx.caption, published: settled, liveUrl };
  } catch (err) {
    // Release the claim into a retryable failed state and surface the error.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(productionItems)
      .set({
        zernioStatus: "failed",
        zernioError: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));

    await recordToolAction({
      contentItemId: itemId,
      userId: opts.actorUserId,
      tool: "zernio",
      action: "draft_send_failed",
      status: "error",
      label: "TikTok inbox send failed",
      meta: { reason: message.slice(0, 300) },
    });

    throw err;
  }
}

export interface ReconcileResult {
  zernioStatus: string | null;
  publishedLink: string | null;
  status: string | null;
  /** True if this call moved the item to a terminal state. */
  settled: boolean;
}

/**
 * Check a `publishing` item against Zernio and flip it to its terminal state.
 * Direct publish is async on Zernio's side — this is how a `publishing` item
 * becomes `published` (with its live link, when TikTok returns one) or
 * `failed`. Idempotent + safe to call from anywhere: the client poller, the
 * worker fallback, and the webhook all funnel through here.
 *
 * The link: TikTok's Content Posting API returns only a publish id, so we look
 * the real URL up in the account's post feed (`resolvePublishedUrl`). That
 * post takes a few seconds to appear, so we DON'T settle a live post until the
 * link resolves — we keep polling. `finalizeWithoutLink` (used by the worker
 * poll at its deadline) force-settles a linkless live post so it can't poll
 * forever.
 */
export async function reconcileTikTokPublish(
  itemId: string,
  actorUserId: string | null = null,
  opts: { finalizeWithoutLink?: boolean } = {},
): Promise<ReconcileResult> {
  const [item] = await db
    .select({
      zernioPostId: productionItems.zernioPostId,
      zernioStatus: productionItems.zernioStatus,
      status: productionItems.status,
      publishedLink: productionItems.publishedLink,
      publishedAt: productionItems.publishedAt,
      zernioSentAt: productionItems.zernioSentAt,
      zernioAccountId: accounts.zernioAccountId,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(eq(productionItems.id, itemId))
    .limit(1);

  const current = (settled: boolean): ReconcileResult => ({
    zernioStatus: item?.zernioStatus ?? null,
    publishedLink: item?.publishedLink ?? null,
    status: item?.status ?? null,
    settled,
  });

  // Only act on in-flight items; anything else is already terminal.
  if (!item || !item.zernioPostId || item.zernioStatus !== "publishing") {
    return current(item?.zernioStatus !== "publishing");
  }

  let post;
  try {
    post = await getPost(item.zernioPostId);
  } catch {
    return current(false); // transient — keep polling
  }
  const target = tikTokTarget(post);

  if (target?.status === "failed") {
    await db
      .update(productionItems)
      .set({
        zernioStatus: "failed",
        zernioError: (target.errorMessage ?? "TikTok rejected the post").slice(
          0,
          1000,
        ),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return { zernioStatus: "failed", publishedLink: null, status: item.status, settled: true };
  }

  if (target?.status === "published") {
    // Look up the REAL post URL in the account feed (matched by recency +
    // caption). Falls back to any link we already have.
    let caption = "";
    const [draft] = await db
      .select({ content: contentDrafts.content })
      .from(contentDrafts)
      .where(
        and(
          eq(contentDrafts.productionItemId, itemId),
          eq(contentDrafts.isCurrent, true),
        ),
      )
      .limit(1);
    if (typeof draft?.content?.caption === "string") caption = draft.content.caption;

    const liveUrl =
      item.publishedLink ??
      (await resolvePublishedUrl(
        item.zernioAccountId,
        caption,
        item.zernioSentAt,
      ));

    // Live but the post isn't in the account feed yet → keep polling so we can
    // attach the real URL, unless we're force-finalizing at the deadline.
    if (!liveUrl && !opts.finalizeWithoutLink) {
      return current(false);
    }

    const set: Record<string, unknown> = {
      zernioStatus: "published",
      zernioError: null,
      status: "Published",
      updatedAt: new Date(),
    };
    if (item.publishedAt == null) set.publishedAt = new Date();
    if (liveUrl && !item.publishedLink) set.publishedLink = liveUrl;
    await db
      .update(productionItems)
      .set(set)
      .where(eq(productionItems.id, itemId));

    await recordToolAction({
      contentItemId: itemId,
      userId: actorUserId,
      tool: "zernio",
      action: "published",
      status: "success",
      label: "Published to TikTok",
      url: liveUrl ?? null,
      meta: { zernioPostId: item.zernioPostId },
    });

    return {
      zernioStatus: "published",
      publishedLink: liveUrl ?? null,
      status: "Published",
      settled: true,
    };
  }

  return current(false); // still publishing
}
