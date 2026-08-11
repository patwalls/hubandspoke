import { NextRequest, NextResponse } from "next/server";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  contentEvents,
  formats,
  productionItems,
  repurposeTriggers,
  users,
} from "@/lib/db/schema";
import { recordItemCreated } from "@/lib/services/item-created";
import {
  getChannelsForFormats,
  pickBestAccountForFormat,
} from "@/lib/format-channels";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { enqueue } from "@/jobs/enqueue";
import { extractCanvaTemplateId } from "@/lib/canva-skill";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/repurpose
 *
 * Body: { targetFormatId: string, editorUserId?: string }
 *
 * Spawn a derivative production_item in `targetFormatId`, pre-linked to the
 * source as a pillar and assigned to `editorUserId` when provided (the SPOKE
 * queue picker), else the calling user (the content-detail Actions menu, which
 * has no picker). Replaces the legacy
 * Claude+Descript dispatcher: no LLM, no Descript clip job — the editor
 * does the work by hand on the new item's detail page.
 *
 * No application-level dedup: a manual click is treated as the editor
 * deliberately wanting another draft (different angle, different framing,
 * etc.), so we always create. `threshold-monitor-sweep` does its own
 * dedup against `repurpose_triggers` for cron-driven fan-out, so this
 * change doesn't cause runaway auto-creation.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  let body: { targetFormatId?: unknown; editorUserId?: unknown };
  try {
    body = (await request.json()) as {
      targetFormatId?: unknown;
      editorUserId?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 }
    );
  }
  const targetFormatId =
    typeof body.targetFormatId === "string" && body.targetFormatId.trim()
      ? body.targetFormatId.trim()
      : "";
  if (!targetFormatId) {
    return NextResponse.json(
      { error: "targetFormatId is required" },
      { status: 400 }
    );
  }
  const editorUserIdOverride =
    typeof body.editorUserId === "string" && body.editorUserId.trim().length > 0
      ? body.editorUserId.trim()
      : null;

  const [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!source) {
    return NextResponse.json(
      { error: "Source item not found" },
      { status: 404 }
    );
  }

  const [target] = await db
    .select()
    .from(formats)
    .where(eq(formats.id, targetFormatId))
    .limit(1);
  if (!target) {
    return NextResponse.json(
      { error: "Target format not found" },
      { status: 404 }
    );
  }
  if (target.brand !== source.brand) {
    return NextResponse.json(
      { error: "Target format must belong to the same brand" },
      { status: 400 }
    );
  }

  // Channel: the format's first persisted target. Both fields nullable —
  // a freshly-created format with no channels yet still produces a row,
  // the editor sets the channel later on the detail page.
  const channelMap = await getChannelsForFormats([target.id]);
  const firstChannel = channelMap.get(target.id)?.[0] ?? null;

  // Multi-channel formats (e.g. "Daily Seinfeld" → both X and Newsletter)
  // produce multiple format_channels rows; `firstChannel` arbitrarily
  // picks one by insert order. Prefer "what account this format has
  // actually been published on most" so the new derivative lands on the
  // right destination. Falls back to firstChannel when nothing in this
  // format has shipped yet.
  const bestAccount = await pickBestAccountForFormat({
    brand: source.brand,
    format: target.name,
    postType: firstChannel?.postType ?? null,
  });
  const resolvedAccountId =
    bestAccount?.accountId ?? firstChannel?.accountId ?? null;
  if (bestAccount) {
    console.info(
      `repurpose-create: format="${target.name}" picked account=${bestAccount.accountId} by-history (views=${bestAccount.totalViews}, items=${bestAccount.itemCount})`,
    );
  }

  // Editor: the SPOKE queue picker sends `editorUserId`; the content-detail
  // Actions menu sends nothing and the clicker takes it. Validate an override
  // points at a real user so a stale picker value can't orphan the assignment.
  let editorUserId = actorUserId;
  let editorName: string | null = null;
  if (editorUserIdOverride) {
    const [editor] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, editorUserIdOverride))
      .limit(1);
    if (!editor) {
      return NextResponse.json(
        { error: "Editor not found" },
        { status: 400 }
      );
    }
    editorUserId = editor.id;
    editorName = editor.name?.trim() || editor.email.split("@")[0] || editor.email;
  }

  // Format validation is belt-and-braces — `target` is a row in the
  // formats table by construction, so this should always succeed and
  // returns the canonical-cased name.
  const formatCheck = await normalizeFormatForWrite(source.brand, target.name);
  const canonicalFormat = formatCheck.ok ? formatCheck.value : target.name;

  const [created] = await db
    .insert(productionItems)
    .values({
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      status: "Assigned",
      accountId: resolvedAccountId,
      postType: firstChannel?.postType ?? null,
      format: canonicalFormat,
      sourceType: "repurposed",
      pillarContentNotionId: source.notionId,
      pillarContentItemId: source.id,
      utmCampaign: await generateUtmCampaign(source.title),
      editorUserId,
      createdVia: "api:repurpose",
    })
    .returning({ id: productionItems.id });

  // Log the editor assignment in the activity feed when an explicit editor was
  // picked (SPOKE queue). The self-assign path (Actions menu) skips this —
  // "Pat added Pat as editor" is noise. Mirrors the cross-post convention:
  // payload stores the display name, not the id.
  if (editorUserIdOverride && editorName) {
    try {
      await db.insert(contentEvents).values({
        contentItemId: created.id,
        userId: actorUserId,
        eventType: "editor_change",
        payload: { type: "editor_change", from: null, to: editorName },
      });
    } catch (err) {
      console.error("[api:repurpose] editor_change event failed", err);
    }
  }

  try {
    await recordItemCreated(db, {
      itemId: created.id,
      source: "api:repurpose",
      actorUserId,
      format: canonicalFormat,
      sourceType: "repurposed",
      postType: firstChannel?.postType ?? null,
    });
  } catch (err) {
    console.error("[api:repurpose] recordItemCreated failed", err);
  }

  // Mirror the existing manual-task trigger shape so threshold-monitor-
  // sweep's dedup on (productionItemId, targetFormatId) catches manually-
  // created derivatives too.
  await db.insert(repurposeTriggers).values({
    productionItemId: source.id,
    targetFormatId: target.id,
    compositionName: target.name,
  });

  // Fire the Draft Algorithm so the editor lands on a populated form
  // instead of a blank one. Skips internally if the pillar has no
  // transcript, or if the inherited post_type isn't in the V1 supported
  // set — the editor still sees the item, just empty in those cases.
  // Fire-and-forget; a failed enqueue mustn't block the create response.
  try {
    await enqueue("draft-algorithm-run", {
      productionItemId: created.id,
    });
  } catch (err) {
    console.error("draft-algorithm-run enqueue (repurpose) failed:", err);
  }

  // Canva create-copy: only when the target format is explicitly tagged
  // as is_canva_format AND its Skill contains a Canva brand-template URL.
  // Both gates needed: the flag is the "yes this format wants Canva"
  // signal (editor-toggleable, sibling to is_clip_descript_format), the
  // URL is where the template lives. Without the flag, the integration
  // stays inert even if a Canva URL was pasted as a reference. The worker
  // task does the slow work — Claude-extracts hook/stack_list/cta from the
  // pillar transcript, then calls the Canva autofill API and polls until
  // done. Fire-and-forget so the create response stays fast.
  if (target.isCanvaFormat && target.instructions) {
    const brandTemplateId = extractCanvaTemplateId(target.instructions);
    if (brandTemplateId) {
      try {
        await enqueue("canva-create-copy", {
          productionItemId: created.id,
          brandTemplateId,
        });
      } catch (err) {
        console.error("canva-create-copy enqueue (repurpose) failed:", err);
      }
    }
  }

  invalidateReportCaches();
  return NextResponse.json({ id: created.id }, { status: 201 });
}
