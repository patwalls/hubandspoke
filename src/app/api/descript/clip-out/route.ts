import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems, formats } from "@/lib/db/schema";
import { invokeDescriptAgent } from "@/lib/descript";
import { dispatchRepurpose } from "@/lib/repurpose-agent";

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

  let action;
  try {
    action = await dispatchRepurpose({
      itemTitle: item.title || "Untitled",
      targetFormatName: target.name,
      targetPrompt: target.instructions || "",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Claude dispatch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (action.kind === "no_action") {
    return NextResponse.json({
      mode: "no_action",
      message: action.message,
      targetFormatName: target.name,
    });
  }

  const { startSec, endSec, compositionName } = action;
  const promptToDescript = [
    target.instructions?.trim() || "",
    "",
    `Create a new composition named '${compositionName}' containing a clip from ${mmss(startSec)} to ${mmss(endSec)} of the main composition.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const result = await invokeDescriptAgent({
      projectId: item.descriptProjectId,
      prompt: promptToDescript,
    });
    return NextResponse.json({
      mode: "descript_clip",
      jobId: result.jobId,
      projectUrl: result.projectUrl,
      prompt: promptToDescript,
      window: { startSec, endSec },
      compositionName,
      targetFormatName: target.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
