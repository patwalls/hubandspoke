import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems, formats, repurposeTriggers } from "@/lib/db/schema";
import {
  invokeDescriptAgent,
  fetchDescriptJob,
  extractCompositionIdFromAgentResponse,
} from "@/lib/descript";
import { dispatchRepurpose } from "@/lib/repurpose-agent";
import { createNotionRepurposeTask } from "@/lib/services/notion-tasks";

async function resolveCompositionInBackground(
  triggerId: string,
  jobId: string
) {
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const job = await fetchDescriptJob(jobId);
      if (job.job_state === "stopped") {
        const compositionId = extractCompositionIdFromAgentResponse(
          job.result?.agent_response
        );
        await db
          .update(repurposeTriggers)
          .set({ descriptCompositionId: compositionId })
          .where(eq(repurposeTriggers.id, triggerId));
        return;
      }
    } catch (err) {
      console.error("resolveCompositionInBackground error:", err);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
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

  try {
    const result = await invokeDescriptAgent({
      projectId: item.descriptProjectId,
      prompt: action.descriptPrompt,
    });

    // Create a matching Notion page so the clip flows back into our DB
    // via the next Notion sync — Notion stays the source of truth for
    // content items, and freelancers discuss each clip on its Notion page.
    let notionPageId: string | undefined;
    try {
      const notionResult = await createNotionRepurposeTask({
        pillarContentTitle: item.title || "Untitled",
        targetFormatName: target.name,
        title: action.compositionName,
        channel: Array.isArray(target.channels) ? target.channels[0] : undefined,
        pillarContentNotionId: item.notionId || undefined,
        targetFormatNotionPageId: target.notionPageId || undefined,
        editorNotionUserId: target.editorNotionUserId || undefined,
        descriptProjectUrl: result.projectUrl,
      });
      if (notionResult.success) {
        notionPageId = notionResult.notionPageId;
      } else {
        console.error("Notion page creation failed:", notionResult.error);
      }
    } catch (err) {
      console.error("Notion page creation threw:", err);
    }

    const [trigger] = await db
      .insert(repurposeTriggers)
      .values({
        productionItemId: item.id,
        targetFormatId: target.id,
        descriptJobId: result.jobId,
        descriptProjectUrl: result.projectUrl,
        descriptPrompt: action.descriptPrompt,
        compositionName: action.compositionName,
        notionTaskPageId: notionPageId,
      })
      .returning({ id: repurposeTriggers.id });

    // Fire and forget — resolves the compositionId once Descript finishes.
    // Heroku keeps the Node process alive; works fine after the response.
    resolveCompositionInBackground(trigger.id, result.jobId).catch(() => {});

    return NextResponse.json({
      mode: "descript_clip",
      triggerId: trigger.id,
      jobId: result.jobId,
      projectUrl: result.projectUrl,
      descriptPrompt: action.descriptPrompt,
      compositionName: action.compositionName,
      targetFormatName: target.name,
      notionPageId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
