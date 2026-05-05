import { NextRequest, NextResponse } from "next/server";
import { isNotNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createShortLink,
  listShortLinks,
  ShortLinksApiError,
} from "@/lib/services/short-links";

export const dynamic = "force-dynamic";

async function requireUser() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { session };
}

function handleApiError(err: unknown) {
  if (err instanceof ShortLinksApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[short-links proxy]", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if (gate.error) return gate.error;
  try {
    const includeArchived = request.nextUrl.searchParams.get("include_archived") === "true";
    const tag = request.nextUrl.searchParams.get("tag") ?? undefined;
    const [links, usageRows] = await Promise.all([
      listShortLinks({ includeArchived, tag }),
      db
        .select({
          slug: productionItems.shortLinkSlug,
          count: sql<number>`count(*)::int`,
        })
        .from(productionItems)
        .where(isNotNull(productionItems.shortLinkSlug))
        .groupBy(productionItems.shortLinkSlug),
    ]);

    const usageBySlug = new Map<string, number>();
    for (const row of usageRows) {
      if (row.slug) usageBySlug.set(row.slug, row.count);
    }
    const augmented = links.map((l) => ({
      ...l,
      inUseCount: usageBySlug.get(l.slug) ?? 0,
    }));
    return NextResponse.json({ shortLinks: augmented });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if (gate.error) return gate.error;
  try {
    const body = await request.json();
    const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const destinationUrl = typeof body?.destinationUrl === "string" ? body.destinationUrl.trim() : "";
    const tag = typeof body?.tag === "string" ? body.tag.trim() || null : null;

    if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });
    if (!isHttpsUrl(destinationUrl)) {
      return NextResponse.json({ error: "destinationUrl must be an https:// URL" }, { status: 400 });
    }

    const created = await createShortLink({ slug, destinationUrl, tag });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}

function isHttpsUrl(value: string): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}
