import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  formats,
  productionItems,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import {
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

// Focused regenerate path for the reply CTA only. Sits alongside the full
// draft-algorithm-run path (`./run.ts`) — that one regenerates the body
// AND the cta together (with `force=true`) and would clobber a hand-typed
// tweet. Editors need a "just refresh the reply" button for when the body
// is fine but the CTA copy / link is wrong. This service does:
//
//   1. Resolve channel + utm_campaign from the item.
//   2. Single Opus 4.7 call: same CTA BASELINE TEMPLATE the main agent
//      uses, plus the format Skill (for overrides) and pillar title (for
//      episode lookup via web_search). NO transcript, NO past captions,
//      NO media context — the cta doesn't depend on any of that.
//   3. Clone-on-write: insert a new content_drafts row that preserves
//      every other content key from the current draft and updates only
//      `cta`. Records one content_changed event on the cta field so the
//      activity feed reflects who regenerated it.
//
// Skip codes mirror the main algorithm's pattern so the route's error
// shape stays consistent.

const MODEL = "claude-opus-4-7";
export const REGENERATE_CTA_VERSION = 1;
export const REGENERATE_CTA_GENERATED_BY = `regen-cta:v${REGENERATE_CTA_VERSION}:${MODEL}`;

const SYSTEM_PROMPT = `You write the reply CTA underneath a social-media post for a production team that turns long-form interviews into posts across X, LinkedIn, and YouTube Community.

CTA BASELINE TEMPLATE
You must always return a non-empty cta string. Default shape — exactly two lines of copy with a blank line between (a literal "\\n\\n" separator):

  If you want more stuff like this, check out

  <link>

Where <link> is chosen in this order of preference:
1. If FORMAT REFERENCES & EDITORIAL NOTES specify a URL (a lead-magnet path like starterstory.com/<slug>, or an explicit episode-link directive), use that URL.
2. If the editorial notes say to link to "the actual episode" — or the pillar is clearly a Starter Story podcast / interview episode and the format calls for the episode URL — call the web_search tool with the pillar title to find the published starterstory.com episode URL, then use that URL. Don't invent episode URLs; if web_search returns nothing usable, fall back to the lead-magnet default in step 3.
3. Otherwise default to https://starterstory.com/micro.

Append UTM params to the chosen link, using the values in the CTA CONTEXT block verbatim:
- utm_source={channel}
- utm_campaign={utmCampaign}    (drop this param entirely when CTA CONTEXT shows utmCampaign as "(none)")
- Use "?" as the separator before the first param, then "&" between params. NEVER use "/" as a separator — that turns a query param into a path segment and breaks the link.

URL CONSTRUCTION EXAMPLES (follow these verbatim):
- channel="x", utmCampaign="hello-123", base="https://starterstory.com/micro"
  → https://starterstory.com/micro?utm_source=x&utm_campaign=hello-123
- channel="linkedin", utmCampaign="(none)", base="https://starterstory.com/solo"
  → https://starterstory.com/solo?utm_source=linkedin
- channel="ytcommunity", utmCampaign="ep-42", base="https://starterstory.com/episode/founder-burnout"
  → https://starterstory.com/episode/founder-burnout?utm_source=ytcommunity&utm_campaign=ep-42

OVERRIDE: if FORMAT REFERENCES & EDITORIAL NOTES specify a different CTA copy, link shape, or template, follow the Skill — Skill wins over the baseline. The baseline applies when the Skill is silent on CTAs.

OUTPUT
Call propose_cta exactly once with the final cta string. Never respond with plain text.`;

interface RegenerateCtaArgs {
  productionItemId: string;
  actorUserId: string | null;
}

export type RegenerateCtaSkipReason =
  | "item_not_found"
  | "no_cta_field"
  | "no_current_draft"
  | "unsupported_post_type";

export interface RegenerateCtaResult {
  status: "generated" | "skipped";
  reason?: RegenerateCtaSkipReason;
  draftId?: string;
  ctaPreview?: string;
}

// Mirror of CTA_CHANNEL_BY_POST_TYPE in `./run.ts`. Keep in sync — both
// gate "this post type supports a CTA reply". When adding a new post
// type to one, add it to the other.
const CTA_CHANNEL_BY_POST_TYPE: Partial<Record<PostType, string>> = {
  x: "x",
  linkedin: "linkedin",
  youtube_community: "ytcommunity",
  threads: "threads",
};

export async function regenerateCtaForItem(
  args: RegenerateCtaArgs,
): Promise<RegenerateCtaResult> {
  const { productionItemId, actorUserId } = args;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      brand: productionItems.brand,
      postType: productionItems.postType,
      utmCampaign: productionItems.utmCampaign,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) return { status: "skipped", reason: "item_not_found" };

  const postType = item.postType as PostType | null;
  if (!postType) return { status: "skipped", reason: "unsupported_post_type" };

  const channel = CTA_CHANNEL_BY_POST_TYPE[postType];
  const ctaFieldKey = PLATFORM_FIELD_MAP[postType]?.cta ?? null;
  if (!channel || !ctaFieldKey) {
    return { status: "skipped", reason: "no_cta_field" };
  }

  const [current] = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, productionItemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);
  if (!current) return { status: "skipped", reason: "no_current_draft" };

  // Resolve pillar title for the web_search fallback. The pillar carries
  // the long-form episode title; the derivative row's title is often a
  // copy or a clipped hook — searching with the pillar title gives the
  // tool the best chance of finding the starterstory.com episode page.
  let pillarTitle: string | null = item.title;
  if (item.pillarContentItemId) {
    const [pillar] = await db
      .select({ title: productionItems.title })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (pillar?.title) pillarTitle = pillar.title;
  }

  let formatInstructions: string | null = null;
  if (item.format) {
    const [fmt] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
      .limit(1);
    formatInstructions = fmt?.instructions ?? null;
  }

  const newCta = await callOpusForCta({
    channel,
    utmCampaign: item.utmCampaign ?? null,
    pillarTitle,
    formatInstructions,
  });

  // Clone-on-write: demote current, insert v+1 with the updated cta.
  // Preserve every other content key from the current draft so a body
  // the editor hand-typed doesn't get wiped. Keep the schema snapshot
  // from the current draft (it already permits cta in v2 schemas; for
  // an old v1 snapshot the PATCH endpoint will reject future cta edits
  // but that's the rare case and a Redraft fixes it).
  const prevContent = (current.content ?? {}) as ContentDraftContent;
  const nextContent: ContentDraftContent = { ...prevContent, [ctaFieldKey]: newCta };

  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(contentDrafts.id, current.id));

    const [next] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId,
        version: current.version + 1,
        isCurrent: true,
        content: nextContent,
        fieldSchemaSnapshot: current.fieldSchemaSnapshot as FormatFieldSchema,
        generatedBy: REGENERATE_CTA_GENERATED_BY,
        promptVersion: null,
        modelUsage: null,
        createdByUserId: actorUserId,
      })
      .returning();

    const changes: ContentChange[] = [
      {
        target: {
          kind: "draft_field",
          draftId: next.id,
          version: next.version,
          field: ctaFieldKey,
        },
        from: typeof prevContent[ctaFieldKey] === "string"
          ? (prevContent[ctaFieldKey] as string)
          : null,
        to: newCta,
      },
    ];
    await recordContentChanges({
      tx,
      contentItemId: productionItemId,
      userId: null,
      // Same algorithm-source as the full draft-algorithm — regenerate-cta
      // is a focused variant, not a separate engine. Activity feed badge
      // says "Draft Algorithm" for both, which is the right read.
      source: { kind: "algorithm", name: "draft-algorithm" },
      changes,
    });

    return next;
  });

  // For the next iteration of bisecting "is the agent reading the Skill?",
  // mirror the diagnostic line shape the main algorithm uses so logs are
  // greppable together.
  const skillChars = formatInstructions?.length ?? 0;
  const skillHead = (formatInstructions ?? "")
    .slice(0, 160)
    .replace(/\s+/g, " ")
    .trim();
  console.info(
    `regenerate-cta v${REGENERATE_CTA_VERSION} item=${productionItemId} format="${item.format ?? "(none)"}" channel=${channel} skill_chars=${skillChars} skill_head="${skillHead}"`,
  );

  return {
    status: "generated",
    draftId: inserted.id,
    ctaPreview: newCta,
  };
}

async function callOpusForCta(args: {
  channel: string;
  utmCampaign: string | null;
  pillarTitle: string | null;
  formatInstructions: string | null;
}): Promise<string> {
  const client = new Anthropic();

  const tools: Anthropic.Tool[] = [
    {
      name: "propose_cta",
      description:
        "Submit the final cta reply string. Always returns a non-empty value following the CTA BASELINE TEMPLATE.",
      input_schema: {
        type: "object",
        properties: {
          cta: {
            type: "string",
            description:
              "The full reply CTA text. Follow the CTA BASELINE TEMPLATE in the system prompt — default shape is 'If you want more stuff like this, check out\\n\\n<link>' with utm_source and utm_campaign appended to the link.",
          },
        },
        required: ["cta"],
      },
    },
    // Anthropic native web_search server tool. SDK Tool type may not
    // cover server-tool shapes yet — cast through unknown. max_uses caps
    // the worst case at 2 searches per CTA regen.
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 2,
    } as unknown as Anthropic.Tool,
  ];

  const userPayload = [
    `## CTA CONTEXT`,
    `Use these literal values when constructing the CTA reply's link UTMs:`,
    `- channel: ${args.channel}`,
    `- utmCampaign: ${args.utmCampaign ?? "(none)"}`,
    ``,
    `## PILLAR TITLE`,
    `${args.pillarTitle ?? "(unknown)"}`,
    ``,
    args.formatInstructions
      ? [
          `## FORMAT REFERENCES & EDITORIAL NOTES`,
          `Free text maintained by the team for this format. Extract any CTA-relevant guidance: link template, copy patterns, or an explicit episode-link directive. Ignore admin noise (Loom videos, login credentials, generic onboarding).`,
          ``,
          args.formatInstructions,
        ].join("\n")
      : `## FORMAT REFERENCES & EDITORIAL NOTES\n(no format Skill set — fall through to baseline)`,
    ``,
    `## TASK`,
    `Call propose_cta exactly once with the final cta string for this post. Apply the CTA BASELINE TEMPLATE rules from the system prompt.`,
  ].join("\n");

  const MAX_ITERATIONS = 3;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: userPayload }] },
  ];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: "auto" },
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const propose = toolUses.find((b) => b.name === "propose_cta");
    if (propose) {
      const input = (propose.input ?? {}) as { cta?: unknown };
      if (typeof input.cta === "string" && input.cta.trim()) {
        return input.cta.trim();
      }
      throw new Error("regenerate-cta: propose_cta returned an empty cta");
    }

    if (toolUses.length === 0) {
      throw new Error(
        `regenerate-cta: model stopped without proposing a cta (stop_reason=${response.stop_reason})`,
      );
    }

    // Unknown client tool — surface an error result and let the model
    // recover by calling propose_cta. web_search is server-side and
    // arrives as a server_tool_use block, so it never lands here.
    const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: JSON.stringify({
        error: `Unknown tool: ${tu.name}. Call propose_cta now.`,
      }),
      is_error: true,
    }));
    messages.push({ role: "user", content: results });
  }

  throw new Error(
    `regenerate-cta: tool loop exceeded ${MAX_ITERATIONS} iterations without a propose_cta call`,
  );
}
