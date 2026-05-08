import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/sync-descript-publish
 *
 * Manual trigger for the Descript publish-and-archive flow. Used by the
 * "Download from Descript" button in the Actions dropdown so an editor can
 * pull fresh edits from a Descript composition into our S3 bucket.
 *
 * Body (optional): { force?: boolean }
 *
 * Race guard: refuses (409) when a render is already in flight unless
 * `force: true` is passed. The Retry button on the failed-pill state passes
 * force.
 *
 * Once enqueued, the existing `descript-publish-and-archive` task takes
 * over: kick off /jobs/publish, poll, download, archive, stamp
 * `descript_published_at`. The status pill polls /descript-status and
 * reflects the rendering state.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const body = (await request.json().catch(() => ({}))) as { force?: unknown };
  const force = body.force === true;

  const [item] = await db
    .select({
      id: productionItems.id,
      descriptProjectId: productionItems.descriptProjectId,
      descriptCompositionId: productionItems.descriptCompositionId,
      descriptPublishJobId: productionItems.descriptPublishJobId,
      descriptPublishedAt: productionItems.descriptPublishedAt,
      descriptPublishError: productionItems.descriptPublishError,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (!item.descriptProjectId || !item.descriptCompositionId) {
    return NextResponse.json(
      {
        error:
          "No Descript composition to sync from. Create one first via the Clip Idea dialog.",
      },
      { status: 400 },
    );
  }

  // Race guard: a render is "in flight" when a job_id is set but no
  // success or failure has landed yet. force=true bypasses (used by Retry).
  const inFlight =
    !!item.descriptPublishJobId &&
    !item.descriptPublishedAt &&
    !item.descriptPublishError;
  if (inFlight && !force) {
    return NextResponse.json(
      {
        error:
          "A render is already in flight. Wait for it to finish, or pass {force: true} to override.",
      },
      { status: 409 },
    );
  }

  // Reset job_id + error so the task starts clean. Leave `descript_published_at`
  // alone — the simulator should keep showing the previous render until the new
  // one lands (avoids a black-frame flicker mid-sync).
  await db
    .update(productionItems)
    .set({
      descriptPublishJobId: null,
      descriptPublishError: null,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, id));

  await enqueue("descript-publish-and-archive", {
    productionItemId: id,
    force: true, // skip the "already rendered" guard since the user explicitly asked
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
