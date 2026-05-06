import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { buildRepostValues } from "@/lib/services/repost-values";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Statuses the repost route accepts. v1 callers (content-detail's
 *  manual "Repost" submenu) keep landing in `Idea`; the repost queue v2
 *  triage dialog passes `Ready To Publish` to skip the review step. */
const ACCEPTED_STATUSES = ["Idea", "Ready To Publish"] as const;
type AcceptedStatus = (typeof ACCEPTED_STATUSES)[number];

/**
 * POST /api/production-items/[id]/repost
 *
 * Body (all optional):
 *   - editorUserId: override the resolved editor (used by the queue
 *     triage dialog where the picker selects who'll do the work)
 *   - status: "Idea" | "Ready To Publish" — defaults to "Idea". The
 *     repost queue v2 sets "Ready To Publish" since reposts skip the
 *     usual review cycle.
 *
 * Creates a new `repost` production item that mirrors the source on the
 * same platform(s). Inherits title, thumbnail, format, pillar, and
 * brand from the source. Writes a `repost_created` content event so the
 * activity feed shows the lineage.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  // Parse optional body. Empty body is fine — keeps v1 callers working.
  const body = (await request.json().catch(() => ({}))) as {
    editorUserId?: unknown;
    status?: unknown;
  };
  const requestedStatus =
    typeof body.status === "string" &&
    (ACCEPTED_STATUSES as readonly string[]).includes(body.status)
      ? (body.status as AcceptedStatus)
      : "Idea";
  const requestedEditorUserId =
    typeof body.editorUserId === "string" && body.editorUserId.length > 0
      ? body.editorUserId
      : null;

  const [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  // Legacy/oddball items pre-date the accounts rollout — they don't have an
  // accountId/postType and aren't repost-eligible until backfilled.
  if (!source.accountId || !source.postType) {
    return NextResponse.json(
      { error: "Source item is missing accountId or postType — backfill required before reposting." },
      { status: 422 }
    );
  }

  // Don't carry a stale `format` from the source — if it doesn't exist in
  // the brand's formats table, set null instead of propagating the drift.
  const formatCheck = await normalizeFormatForWrite(source.brand, source.format);
  const inheritedFormat = formatCheck.ok ? formatCheck.value : null;

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: inheritedFormat,
  });
  const editorUserId = requestedEditorUserId ?? assignees.editorUserId;

  const baseValues = buildRepostValues(
    {
      id: source.id,
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      accountId: source.accountId,
      postType: source.postType,
      platform: source.platform,
      format: inheritedFormat,
      pillarContentItemId: source.pillarContentItemId,
      pillarContentNotionId: source.pillarContentNotionId,
      evergreenReasoning: source.evergreenReasoning,
    },
    {
      utmCampaign: await generateUtmCampaign(source.title),
      producerUserId: assignees.producerUserId,
      editorUserId,
    }
  );

  const [created] = await db
    .insert(productionItems)
    .values({ ...baseValues, status: requestedStatus })
    .returning({ id: productionItems.id });

  // Activity-feed event so the source's history shows where the new
  // repost came from. Only emitted on the queue-driven "Ready To
  // Publish" path — the manual `Idea`-status repost is the editor
  // self-creating, no breadcrumb worth surfacing.
  if (requestedStatus === "Ready To Publish") {
    await db.insert(contentEvents).values({
      contentItemId: created.id,
      userId: actorUserId,
      eventType: "repost_created",
      payload: {
        type: "repost_created",
        sourceItemId: source.id,
        sourceTitle: source.title,
      },
    });
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}
