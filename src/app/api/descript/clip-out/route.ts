import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems, formats } from "@/lib/db/schema";
import { invokeDescriptAgent, DEFAULT_CLIP_PROMPT } from "@/lib/descript";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function mmss(totalSec: number): string {
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  return `${mins}:${pad(secs)}`;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { itemId?: string; targetFormatId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemId = body.itemId?.trim();
  const targetFormatId = body.targetFormatId?.trim();
  if (!itemId || !targetFormatId) {
    return NextResponse.json(
      { error: "itemId and targetFormatId required" },
      { status: 400 }
    );
  }

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (!item.descriptProjectId) {
    return NextResponse.json(
      { error: "This content has no Descript project yet" },
      { status: 400 }
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
  if (target.brand !== item.brand) {
    return NextResponse.json(
      { error: "Target format must belong to the same brand" },
      { status: 400 }
    );
  }

  // Random 30-second window starting 30–90s into the video
  const startSec = Math.floor(Math.random() * 60) + 30;
  const endSec = startSec + 30;

  const preamble = target.descriptClipPrompt?.trim() || DEFAULT_CLIP_PROMPT;
  const directive = `Create a new composition named '${target.name}' containing a 30-second highlight from ${mmss(startSec)} to ${mmss(endSec)} of the main composition.`;
  const prompt = `${preamble}\n\n${directive}`;

  try {
    const result = await invokeDescriptAgent({
      projectId: item.descriptProjectId,
      prompt,
    });
    return NextResponse.json({
      jobId: result.jobId,
      projectUrl: result.projectUrl,
      prompt,
      window: { startSec, endSec },
      targetFormatName: target.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
