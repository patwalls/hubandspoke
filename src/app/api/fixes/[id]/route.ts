import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { fixes } from "@/lib/db/schema";

const STATUSES = [
  "open",
  "in_progress",
  "needs_decision",
  "done",
  "wont_fix",
] as const;
type Status = (typeof STATUSES)[number];

const RESOLUTION_MAX = 4000;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await params;

  let body: { status?: string; resolutionNote?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const status = (body.status ?? "").toString();
  if (!(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const update: {
    status: Status;
    updatedAt: Date;
    resolutionNote?: string | null;
  } = {
    status: status as Status,
    updatedAt: new Date(),
  };

  if (typeof body.resolutionNote === "string") {
    const trimmed = body.resolutionNote.trim().slice(0, RESOLUTION_MAX);
    update.resolutionNote = trimmed || null;
  }

  const [row] = await db
    .update(fixes)
    .set(update)
    .where(eq(fixes.id, id))
    .returning({ id: fixes.id, status: fixes.status });

  if (!row) {
    return NextResponse.json({ error: "Fix not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: row.id, status: row.status });
}
