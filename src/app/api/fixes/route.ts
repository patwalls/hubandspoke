import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { fixes } from "@/lib/db/schema";

const CATEGORIES = ["ui", "data_wrong", "automation", "idea", "other"] as const;
type Category = (typeof CATEGORIES)[number];

const NOTE_MAX = 8000;
const HTML_MAX = 2_000_000; // 2 MB cap on the page snapshot

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const session = guard.session;

  let body: {
    note?: string;
    category?: string;
    url?: string;
    pageHtml?: string;
    photoKeys?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const note = (body.note ?? "").toString().trim().slice(0, NOTE_MAX);
  if (!note) {
    return NextResponse.json({ error: "Note is required" }, { status: 400 });
  }

  const rawCategory = (body.category ?? "").toString();
  const category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : null;

  const url = (body.url ?? "").toString().slice(0, 2000) || null;
  const pageHtml = body.pageHtml
    ? String(body.pageHtml).slice(0, HTML_MAX)
    : null;

  const photoKeys = Array.isArray(body.photoKeys)
    ? body.photoKeys
        .filter((k): k is string => typeof k === "string" && k.length > 0)
        .slice(0, 10)
    : [];

  const [row] = await db
    .insert(fixes)
    .values({
      filedByUserId: session.user.id,
      filedByEmail: session.user.email ?? "unknown",
      note,
      category,
      url,
      pageHtml,
      photoKeys,
    })
    .returning({ id: fixes.id });

  return NextResponse.json({ ok: true, id: row.id });
}
