import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateClipIdeas,
  GENERATED_BY,
  PROMPT_VERSION,
  type PerfRow,
} from "@/lib/clip-idea-agent";
import { topShortFormPerformers } from "@/lib/db/queries";
import { findAccountForBrandPlatform } from "@/lib/db/accounts";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];
const PROMOTED_CLIP_FORMAT = "Repackage section with hook";

function isShortForm(platform: string[] | null): boolean {
  if (!platform) return false;
  return platform.some((p) => SHORT_FORM_PLATFORMS.includes(p));
}

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function buildContentBody(args: {
  sourceTitle: string | null;
  startSec: number;
  endSec: number;
  angle: string;
  rationale: string;
}): string {
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const timestampRange = `${formatTimestamp(args.startSec)}–${formatTimestamp(args.endSec)} (${duration}s)`;
  return [
    `Source: ${args.sourceTitle ?? "(untitled)"}`,
    `Timestamp: ${timestampRange}`,
    "",
    `Angle: ${args.angle}`,
    "",
    `Why: ${args.rationale}`,
  ].join("\n");
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      platform: productionItems.platform,
      brand: productionItems.brand,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const transcript = await getTranscriptForPrompt(id);
  if (!transcript) {
    return NextResponse.json(
      { error: "No transcript for this item. Fetch transcript first." },
      { status: 400 }
    );
  }

  // The Sonnet call + potential retry can exceed Heroku's 30s router limit
  // (H12), which would hand the client an HTML error page and blow up
  // res.json() in the panel. Return 202 now and run the generation in the
  // background; the client polls GET /clip-ideas until a new batch lands.
  // Mirrors the pattern in /transcript/fetch/route.ts.
  (async () => {
    // Derivatives of THIS pillar — direct children only (depth 1), short-form.
    // Keeping to depth 1 matches the "clips already made from this video"
    // framing and avoids pulling cousin long-form posts that share an ancestor.
    const derivativeRows = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        platform: productionItems.platform,
        format: productionItems.format,
        views: productionItems.views,
        hook: productionItems.hook,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.pillarContentItemId, id),
          isNotNull(productionItems.views),
          sql`(${productionItems.platform}::jsonb @> '["YouTube Shorts"]'::jsonb OR ${productionItems.platform}::jsonb @> '["Instagram Reel"]'::jsonb OR ${productionItems.platform}::jsonb @> '["TikTok"]'::jsonb)`
        )
      )
      .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
      .limit(20);

    const derivatives: PerfRow[] = derivativeRows
      .filter((d) => isShortForm(d.platform as string[] | null))
      .map((d) => ({
        title: d.title,
        platform: d.platform as string[] | null,
        format: d.format,
        views: d.views,
        hook: d.hook,
      }));

    const topPerfRows = await topShortFormPerformers({
      brand: item.brand,
      excludeDerivativesOfPillarId: id,
      limit: 30,
    });
    const topPerformers: PerfRow[] = topPerfRows.map((r) => ({
      title: r.title,
      platform: r.platform,
      format: r.format,
      views: r.views,
      hook: r.hook,
    }));

    const result = await generateClipIdeas({
      pillarTitle: item.title,
      pillarFormat: item.format,
      pillarChannels: item.platform,
      transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
      durationSec: transcript.durationSec,
      derivatives,
      topPerformers,
    });

    const batchId = randomUUID();

    // Resolve the brand's Instagram account once per batch — every clip lives
    // on the same channel, so a single lookup is fine. Reels are the default
    // surface for short-form clips; if the brand has no Instagram account
    // (e.g. SoS today), we fall through to the legacy "no account, just
    // platform string" shape so the row still inserts.
    const igAccount = await findAccountForBrandPlatform({
      brandSlug: item.brand,
      platform: "instagram",
    });

    // Insert clip_ideas first, then create a sibling production_items row for
    // each so the new ideas land in the central /[brand]/queue alongside
    // reposts and cross-posts. The prod_item is the queue-side representation;
    // clip_ideas remains the triage decision state. The unique partial index
    // `uniq_production_items_source_clip_idea` enforces 1:1 — see
    // schema.ts:304-306. Both rows hold the actor as producer/editor (NOT NULL
    // on prod_items); no notification fires because (a) only PUT diff fires
    // notifications, not insert, and (b) self-notify is suppressed anyway.
    const inserted = await db
      .insert(clipIdeas)
      .values(
        result.ideas.map((idea) => ({
          sourceProductionItemId: id,
          batchId,
          startSec: idea.startSec.toFixed(3),
          endSec: idea.endSec.toFixed(3),
          hook: idea.hook,
          angle: idea.angle,
          rationale: idea.rationale,
          estimatedViews: idea.estimatedViews,
          generatedBy: GENERATED_BY,
          promptVersion: PROMPT_VERSION,
          modelUsage: result.modelUsage,
          status: "suggested" as const,
        })),
      )
      .returning({
        id: clipIdeas.id,
        startSec: clipIdeas.startSec,
        endSec: clipIdeas.endSec,
        hook: clipIdeas.hook,
        angle: clipIdeas.angle,
        rationale: clipIdeas.rationale,
      });

    for (const ci of inserted) {
      const startSecNum = Number(ci.startSec);
      const endSecNum = Number(ci.endSec);
      const body = buildContentBody({
        sourceTitle: item.title,
        startSec: startSecNum,
        endSec: endSecNum,
        angle: ci.angle,
        rationale: ci.rationale,
      });

      const [created] = await db
        .insert(productionItems)
        .values({
          title: ci.hook,
          status: "Idea",
          platform: ["Instagram Reel"],
          postType: "instagram_reel",
          accountId: igAccount?.id ?? null,
          format: PROMOTED_CLIP_FORMAT,
          brand: item.brand,
          contentBody: body,
          pillarContentItemId: id,
          sourceType: "clip",
          sourceClipIdeaId: ci.id,
          producerUserId: actorUserId,
          editorUserId: actorUserId,
          hook: ci.hook,
          hookSource: "clip_idea",
          hookExtractedAt: new Date(),
        })
        .returning({ id: productionItems.id });

      if (created) {
        await db
          .update(clipIdeas)
          .set({ acceptedProductionItemId: created.id })
          .where(eq(clipIdeas.id, ci.id));
      }
    }
  })().catch((err) => {
    console.error(
      `[clip-ideas] background generation failed for item=${id}:`,
      err
    );
  });

  return NextResponse.json(
    { ok: true, status: "pending" },
    { status: 202 }
  );
}
