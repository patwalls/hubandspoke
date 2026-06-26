import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { enqueue } from "@/jobs/enqueue";
import {
  buildTikTokDraftPreview,
  sendTikTokDraft,
  TikTokDraftError,
  type TikTokDraftBlockCode,
} from "@/lib/services/tiktok-draft/send";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Deliver a TikTok item's video to the creator's TikTok inbox as a DRAFT via
 * Zernio. Deliberately SEPARATE from /publish — that route drives
 * status→Published/Scheduled and requires a live link, which is semantically
 * the opposite of "send a draft to an inbox, no link yet". Keeping them apart
 * keeps the well-guarded Published-transition path's blast radius clean.
 *
 * The Zernio "draft sent" state (zernio* columns) is orthogonal to `status`:
 * this route never writes `status`. A human (or the schedule-reconcile sweep)
 * drives the item to Published later, the normal way.
 *
 *   GET  → preview payload for the confirm dialog (read-only).
 *   POST { mode: 'send-now', expectedMediaId?, expectedCaption? }
 *        → send to inbox now (inline), returns { zernioPostId, caption }.
 *   POST { mode: 'schedule', scheduledAt }
 *        → queue OUR worker to send at scheduledAt (lands as a draft).
 *   POST { mode: 'cancel' }
 *        → clear a pending schedule (the orphaned job race-guards itself out).
 */

/** Hard blocks that mean "already in flight / done" → 409; everything else is
 *  a validation failure → 422. */
function statusForBlock(code: TikTokDraftBlockCode): number {
  return code === "already_sent" || code === "claim_lost" ? 409 : 422;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  try {
    const preview = await buildTikTokDraftPreview(id);
    return NextResponse.json({ status: "ok", preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;
  const { id } = await context.params;

  const body = (await request.json().catch(() => ({}))) as {
    mode?: unknown;
    scheduledAt?: unknown;
    expectedMediaId?: unknown;
    expectedCaption?: unknown;
    privacyLevel?: unknown;
  };
  const mode = body.mode;
  const privacyLevel =
    typeof body.privacyLevel === "string" ? body.privacyLevel : undefined;

  if (mode !== "send-now" && mode !== "schedule" && mode !== "cancel") {
    return NextResponse.json(
      { error: "Body must include mode: 'send-now' | 'schedule' | 'cancel'." },
      { status: 400 },
    );
  }

  // ── Send now ────────────────────────────────────────────────────────────
  if (mode === "send-now") {
    try {
      const result = await sendTikTokDraft(id, {
        actorUserId,
        privacyLevel,
        expectedMediaId:
          typeof body.expectedMediaId === "string"
            ? body.expectedMediaId
            : null,
        expectedCaption:
          typeof body.expectedCaption === "string"
            ? body.expectedCaption
            : null,
      });
      return NextResponse.json({
        status: result.published ? "published" : "publishing",
        zernioPostId: result.zernioPostId,
        liveUrl: result.liveUrl,
        caption: result.caption,
      });
    } catch (err) {
      if (err instanceof TikTokDraftError) {
        return NextResponse.json(
          { error: err.block.message, code: err.block.code },
          { status: statusForBlock(err.block.code) },
        );
      }
      // Zernio API / network failure — the send already stamped zernioError.
      const message = err instanceof Error ? err.message : "Send failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // ── Cancel a pending schedule ─────────────────────────────────────────────
  if (mode === "cancel") {
    const cleared = await db
      .update(productionItems)
      .set({ zernioStatus: null, zernioScheduledAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(productionItems.id, id),
          eq(productionItems.zernioStatus, "scheduled"),
        ),
      )
      .returning({ id: productionItems.id });
    // The already-queued worker job will fire, see zernioStatus !== 'scheduled',
    // and race-guard itself out — no need to remove the job explicitly.
    return NextResponse.json({
      status: cleared.length > 0 ? "cancelled" : "noop",
    });
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  const raw = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
  const runAt = raw ? new Date(raw) : null;
  if (!runAt || Number.isNaN(runAt.getTime())) {
    return NextResponse.json(
      { error: "A valid scheduledAt is required to schedule." },
      { status: 400 },
    );
  }
  if (runAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Scheduled time must be in the future." },
      { status: 400 },
    );
  }

  // Validate everything NOW so the user gets immediate feedback (the task
  // re-validates at fire time too).
  const preview = await buildTikTokDraftPreview(id);
  if (preview.blockingReasons.length > 0) {
    const first = preview.blockingReasons[0];
    return NextResponse.json(
      { error: first.message, code: first.code },
      { status: statusForBlock(first.code) },
    );
  }

  // Claim into 'scheduled' (allows null/failed → scheduled; blocks
  // sending/scheduled/delivered/already-sent).
  const claimed = await db
    .update(productionItems)
    .set({
      zernioStatus: "scheduled",
      zernioScheduledAt: runAt,
      zernioError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productionItems.id, id),
        sql`${productionItems.zernioPostId} is null`,
        sql`${productionItems.zernioStatus} is distinct from 'sending'`,
        sql`${productionItems.zernioStatus} is distinct from 'scheduled'`,
        sql`${productionItems.zernioStatus} is distinct from 'delivered'`,
      ),
    )
    .returning({ id: productionItems.id });

  if (claimed.length === 0) {
    return NextResponse.json(
      { error: "This item is already sent or scheduled.", code: "already_sent" },
      { status: 409 },
    );
  }

  // jobKeyMode 'replace' makes reschedule atomic — only one pending job ever
  // exists for this item.
  await enqueue(
    "zernio-create-draft",
    { productionItemId: id, privacyLevel },
    { runAt, jobKey: `zernio:${id}`, jobKeyMode: "replace" },
  );

  return NextResponse.json({ status: "scheduled", scheduledAt: runAt.toISOString() });
}
