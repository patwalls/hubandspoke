import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems, formats, repurposeTriggers } from "@/lib/db/schema";
import { invokeDescriptAgent } from "@/lib/descript";
import { dispatchRepurpose, type RepurposeAction } from "@/lib/repurpose-agent";
import { resolveAssignees } from "@/lib/services/assignees";
import { recordItemCreated } from "@/lib/services/item-created";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { getChannelsForFormats } from "@/lib/format-channels";
import { enqueue } from "@/jobs/enqueue";

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

  let action: RepurposeAction;
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

  // If Claude picked a Descript clip but the pillar has no Descript project,
  // downgrade to a manual task so the editor can do the clip by hand. The
  // user gets a Notion page every time.
  if (action.kind === "descript_clip" && !item.descriptProjectId) {
    action = {
      kind: "manual_task",
      taskName: action.compositionName,
      guidance:
        "This format is a Descript clip, but the pillar has no Descript project yet — do this one by hand.\n\nClip directive Claude would have sent:\n" +
        action.descriptPrompt,
    };
  }

  const targetChannels = await getChannelsForFormats([target.id]);
  const firstChannel = targetChannels.get(target.id)?.[0] ?? null;
  const derivativeAccountId = firstChannel?.accountId ?? null;
  const derivativePostType = firstChannel?.postType ?? null;

  const derivativeAssignees = await resolveAssignees({
    brand: item.brand,
    sourceItemId: item.id,
    format: target.name,
  });

  if (action.kind === "descript_clip") {
    try {
      const result = await invokeDescriptAgent({
        projectId: item.descriptProjectId!,
        prompt: action.descriptPrompt,
      });

      let derivativeItemId: string | undefined;
      try {
        const [derivative] = await db
          .insert(productionItems)
          .values({
            brand: item.brand,
            title: action.compositionName,
            accountId: derivativeAccountId,
            postType: derivativePostType,
            format: target.name,
            status: "Idea",
            pillarContentNotionId: item.notionId,
            pillarContentItemId: item.id,
            descriptProjectId: item.descriptProjectId,
            descriptProjectUrl: result.projectUrl,
            utmCampaign: await generateUtmCampaign(action.compositionName),
            producerUserId: derivativeAssignees.producerUserId,
            editorUserId: derivativeAssignees.editorUserId,
            createdVia: "legacy:descript-clip-out",
          })
          .returning({ id: productionItems.id });
        derivativeItemId = derivative.id;
        try {
          await recordItemCreated(db, {
            itemId: derivative.id,
            source: "legacy:descript-clip-out",
            actorUserId: null,
            format: target.name,
            sourceType: "original",
            postType: derivativePostType,
          });
        } catch (e) {
          console.error("[legacy:descript-clip-out] recordItemCreated failed", e);
        }
      } catch (err) {
        console.error("Derivative production_item insert failed:", err);
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
        })
        .returning({ id: repurposeTriggers.id });

      await enqueue("descript-clip-resolve", {
        triggerId: trigger.id,
        jobId: result.jobId,
        derivativeItemId,
      });

      return NextResponse.json({
        mode: "descript_clip",
        triggerId: trigger.id,
        jobId: result.jobId,
        projectUrl: result.projectUrl,
        descriptPrompt: action.descriptPrompt,
        compositionName: action.compositionName,
        targetFormatName: target.name,
        derivativeItemId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // manual_task
  let derivativeItemId: string | undefined;
  try {
    const [derivative] = await db
      .insert(productionItems)
      .values({
        brand: item.brand,
        title: action.taskName,
        accountId: derivativeAccountId,
        postType: derivativePostType,
        format: target.name,
        status: "Idea",
        pillarContentNotionId: item.notionId,
        pillarContentItemId: item.id,
        utmCampaign: await generateUtmCampaign(action.taskName),
        producerUserId: derivativeAssignees.producerUserId,
        editorUserId: derivativeAssignees.editorUserId,
        createdVia: "legacy:descript-clip-out",
      })
      .returning({ id: productionItems.id });
    derivativeItemId = derivative.id;
    try {
      await recordItemCreated(db, {
        itemId: derivative.id,
        source: "legacy:descript-clip-out",
        actorUserId: null,
        format: target.name,
        sourceType: "original",
        postType: derivativePostType,
      });
    } catch (e) {
      console.error("[legacy:descript-clip-out] recordItemCreated failed", e);
    }
  } catch (err) {
    console.error("Derivative production_item insert failed:", err);
  }

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: item.id,
      targetFormatId: target.id,
      compositionName: action.taskName,
    })
    .returning({ id: repurposeTriggers.id });

  return NextResponse.json({
    mode: "manual_task",
    triggerId: trigger.id,
    taskName: action.taskName,
    guidance: action.guidance,
    targetFormatName: target.name,
    derivativeItemId,
  });
}
