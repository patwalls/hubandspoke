import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { descriptPacks } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const packs = await db
    .select()
    .from(descriptPacks)
    .orderBy(descriptPacks.name);
  return NextResponse.json({ packs });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    prompt?: string;
  } | null;
  const name = body?.name?.trim() ?? "";
  const prompt = body?.prompt ?? "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  const [created] = await db
    .insert(descriptPacks)
    .values({ name, prompt })
    .returning();
  return NextResponse.json(created);
}
