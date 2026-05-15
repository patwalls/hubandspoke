import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/publish
 *
 * Single write site for the Published / Scheduled status transitions.
 * Today (and historically) the generic PUT /api/production-items route
 * accepted any combination of status / publishedLink / publishedDate
 * fields, so it was easy to leak a half-applied state:
 *   - status='Published' with no publishedLink
 *   - publishedLink set but status still 'Ready To Publish'
 *   - status='Published' but publishedDate null
 *
 * This route enforces those invariants in one transaction:
 *   - mode='publish' REQUIRES a non-empty parseable link.
 *   - mode='publish' stamps publishedDate (body value or today UTC) and
 *     publishedAt (only when prior was null — preserves the original
 *     publish moment on subsequent edits, same rule the generic PUT
 *     uses at src/app/api/production-items/route.ts:634–657).
 *   - mode='schedule' flips status to 'Scheduled' and writes nothing
 *     else. Placeholder for full scheduling later.
 *
 * Mirrors the activity-feed events the PUT route emits:
 *   - one `status_change` row (contentEvents)
 *   - one `content_changed` row per field that moved
 *     (recordContentChanges).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;

  const { id } = await context.params;

  const body = (await request.json().catch(() => ({}))) as {
    mode?: unknown;
    link?: unknown;
    publishedDate?: unknown;
  };

  const mode = body.mode;
  if (mode !== "publish" && mode !== "schedule") {
    return NextResponse.json(
      { error: "Body must include mode: 'publish' | 'schedule'." },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select({
      status: productionItems.status,
      publishedLink: productionItems.publishedLink,
      publishedDate: productionItems.publishedDate,
      publishedAt: productionItems.publishedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // Build the field diff up front so the tx body stays small + readable.
  // `nextStatus` is the only field both modes touch.
  const updates: Record<string, unknown> = {};
  const changes: ContentChange[] = [];
  let nextStatus: "Published" | "Scheduled";

  if (mode === "publish") {
    const linkRaw = typeof body.link === "string" ? body.link.trim() : "";
    if (!linkRaw) {
      return NextResponse.json(
        { error: "A published link is required to publish this item." },
        { status: 400 },
      );
    }
    // URL parse — accepts http(s) and other valid URL schemes. Same loose
    // gate the PUT route's platform-mismatch validator already trusts; we
    // don't enforce host whitelisting here.
    try {
      new URL(linkRaw);
    } catch {
      return NextResponse.json(
        { error: `"${linkRaw}" is not a valid URL.` },
        { status: 400 },
      );
    }
    nextStatus = "Published";
    updates.status = "Published";
    updates.publishedLink = linkRaw;

    // publishedDate: body value parsed as YYYY-MM-DD, falling back to
    // today UTC if absent or unparseable. Drizzle's `date` column expects
    // a `YYYY-MM-DD` string (or a Date that gets coerced); pass the
    // canonical string so we don't ride on local timezone for the cast.
    const dateRaw = typeof body.publishedDate === "string"
      ? body.publishedDate.trim()
      : "";
    const dateStr = (() => {
      if (dateRaw) {
        const d = new Date(dateRaw);
        if (!Number.isNaN(d.getTime())) {
          return d.toISOString().slice(0, 10);
        }
      }
      return new Date().toISOString().slice(0, 10);
    })();
    updates.publishedDate = dateStr;

    // publishedAt is THE precise publish moment for same-day sort tie-
    // breaking. Stamp only the first time — a republish (edit) shouldn't
    // overwrite the original moment. Same rule as src/app/api/production-
    // items/route.ts:634–657.
    if (existing.publishedAt == null) {
      updates.publishedAt = new Date();
    }

    if (existing.status !== "Published") {
      changes.push({
        target: { kind: "production_item_field", field: "status" },
        from: existing.status,
        to: "Published",
      });
    }
    if (existing.publishedLink !== linkRaw) {
      changes.push({
        target: { kind: "production_item_field", field: "publishedLink" },
        from: existing.publishedLink,
        to: linkRaw,
      });
    }
    // Drizzle `date` reads back as `YYYY-MM-DD` string; compare on that
    // shape so we don't emit a no-op event when the user clicked Save
    // without touching the date.
    if (existing.publishedDate !== dateStr) {
      changes.push({
        target: { kind: "production_item_field", field: "publishedDate" },
        from: existing.publishedDate,
        to: dateStr,
      });
    }
  } else {
    nextStatus = "Scheduled";
    if (existing.status === "Scheduled") {
      // No-op — caller didn't change anything. Return the row as-is so
      // the UI's optimistic refetch doesn't need to special-case 200-but-
      // nothing-changed.
      return NextResponse.json({ status: "noop" });
    }
    updates.status = "Scheduled";
    changes.push({
      target: { kind: "production_item_field", field: "status" },
      from: existing.status,
      to: "Scheduled",
    });
  }

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(productionItems)
      .set(updates)
      .where(eq(productionItems.id, id))
      .returning();

    if (changes.length > 0) {
      await recordContentChanges({
        tx,
        contentItemId: id,
        userId: actorUserId,
        source: { kind: "user" },
        changes,
      });
    }

    await tx.insert(contentEvents).values({
      contentItemId: id,
      userId: actorUserId,
      eventType: "status_change",
      payload: {
        type: "status_change",
        from: existing.status,
        to: nextStatus,
      },
    });

    return row;
  });

  return NextResponse.json({ status: "ok", item: inserted });
}
