import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { descriptLayoutPacks } from "@/lib/db/schema";
import { probeDescriptLayoutPack } from "@/lib/descript";

/**
 * Registry of Descript layout packs the format dropdown can reference.
 * Descript has no pack-listing API (the agent's own query tool returns an
 * empty list inside API-created projects), so this registry is the source
 * of truth — and POST refuses ids the Descript API can't confirm as real,
 * reachable packs (see probeDescriptLayoutPack).
 */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const packs = await db
    .select()
    .from(descriptLayoutPacks)
    .orderBy(asc(descriptLayoutPacks.name));
  return NextResponse.json({ packs });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: { name?: unknown; url?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; url?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) {
    return NextResponse.json(
      { error: "name and url are required" },
      { status: 400 },
    );
  }

  // Pack page URLs look like web.descript.com/<uuid>[/<slug>] — the UUID is
  // what the agent applies by. Accept a bare UUID too.
  const idMatch = url.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (!idMatch) {
    return NextResponse.json(
      { error: "Couldn't find a pack UUID in that URL" },
      { status: 400 },
    );
  }
  const descriptId = idMatch[1].toLowerCase();

  // All new Descript work happens in the HubSpot account, so packs are
  // validated against (and recorded as belonging to) that token.
  const probe = await probeDescriptLayoutPack(descriptId, "hubspot");
  if (!probe.ok) {
    return NextResponse.json(
      { error: `Not a usable layout pack: ${probe.detail}` },
      { status: 422 },
    );
  }

  const [existing] = await db
    .select({ id: descriptLayoutPacks.id })
    .from(descriptLayoutPacks)
    .where(eq(descriptLayoutPacks.descriptId, descriptId))
    .limit(1);
  if (existing) {
    return NextResponse.json(
      { error: "That pack is already registered" },
      { status: 409 },
    );
  }

  const [created] = await db
    .insert(descriptLayoutPacks)
    .values({
      name,
      descriptId,
      pageUrl: url.startsWith("http") ? url : null,
      descriptAccount: "hubspot",
    })
    .returning();
  return NextResponse.json({ pack: created }, { status: 201 });
}
