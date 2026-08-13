import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  formats,
  productionItems,
  type ContentDraftContent,
} from "@/lib/db/schema";
import { PLATFORM_FIELD_MAP, type PostType } from "@/lib/platform-field-schemas";
import {
  createShortLink,
  findShortLinksByContent,
  updateShortLink,
  ShortLinksApiError,
  type ShortLinkTargetType,
} from "@/lib/services/short-links";
import {
  listLeadMagnets,
  searchContent,
  type LeadMagnet,
} from "@/lib/services/starter-story-content";
import { renderCtaExemplars, type CtaChannel } from "./cta-exemplars";

// Shared "smart, tracked CTA" generator used by BOTH the Regenerate CTA button
// (regenerate-cta.ts) and the full draft algorithm (run.ts). It:
//   1. Reads the post body + format Skill + lead-magnet catalog.
//   2. Asks Opus to write a house-style one-liner AND pick a target — a
//      specific guest's episode when the post is about a guest, else the
//      best-fit lead magnet (episode-first, lead-magnet fallback).
//   3. Mints (or refreshes) ONE go.starterstory.com tracking link per post,
//      pointed at that target + UTMs, recording the content association so
//      clicks trace back to the post.
//   4. Returns the final reply text: "<copyLine>\n<go-link>".
//
// The clone-on-write into content_drafts is the CALLER's job — this service is
// pure "produce the cta string + side-effect the tracking link".

const MODEL = "claude-opus-4-7";
export const TRACKED_CTA_VERSION = 2;

const BASE_URL = process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

export interface TrackedCtaResult {
  cta: string;
  slug: string;
  destinationUrl: string;
  targetType: ShortLinkTargetType;
  leadMagnetId: number | null;
}

export interface GenerateTrackedCtaArgs {
  productionItemId: string;
  /** utm_source value + exemplar channel: x | linkedin | ytcommunity | threads */
  channel: string;
  utmCampaign: string | null;
  /** The caption this CTA replies to — what the post is actually about. */
  postBody: string | null;
  /** Long-form episode title, for the episode search. */
  pillarTitle: string | null;
  formatInstructions: string | null;
}

interface CtaPlan {
  copyLine: string;
  targetType: ShortLinkTargetType;
  targetUrl: string;
  leadMagnetId: number | null;
}

export async function generateTrackedCta(
  args: GenerateTrackedCtaArgs,
): Promise<TrackedCtaResult> {
  const leadMagnets = await listLeadMagnets();
  const plan = await planCta({ ...args, leadMagnets });

  const destinationUrl = buildDestinationUrl(
    plan.targetUrl,
    args.channel,
    args.utmCampaign,
  );

  const slug = await mintTrackedLink({
    productionItemId: args.productionItemId,
    destinationUrl,
    channel: args.channel,
    utmCampaign: args.utmCampaign,
    targetType: plan.targetType,
    leadMagnetId: plan.leadMagnetId,
  });

  const cta = `${plan.copyLine.trim()}\n${BASE_URL}/${slug}`;

  return {
    cta,
    slug,
    destinationUrl,
    targetType: plan.targetType,
    leadMagnetId: plan.leadMagnetId,
  };
}

// Suggest a destination URL for a post WITHOUT minting anything — used to
// pre-fill the DM-keyword dialog's Destination field. Runs the same target
// picker the CTA uses (episode-first / best lead magnet) over the post's body,
// then appends the channel + the post's utm_campaign. Returns null when there's
// no usable context (no item / no draft) so callers can fall back to the manual
// default. Read-only: no short link is created here (the DM-keyword chain
// endpoint mints/wires the actual links on save).
export async function suggestCtaDestination(args: {
  productionItemId: string;
  channel: string;
}): Promise<string | null> {
  const { productionItemId, channel } = args;

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
  if (!item) return null;

  const postType = item.postType as PostType | null;

  // Post body = the current draft's caption (what the picker reads to choose
  // an episode vs. a lead magnet).
  let postBody: string | null = null;
  const [current] = await db
    .select({ content: contentDrafts.content })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, productionItemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);
  if (current && postType) {
    const captionKey = PLATFORM_FIELD_MAP[postType]?.caption ?? null;
    const raw = captionKey
      ? (current.content as ContentDraftContent)[captionKey]
      : null;
    postBody = Array.isArray(raw)
      ? raw.join("\n")
      : typeof raw === "string"
        ? raw
        : null;
  }

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

  const leadMagnets = await listLeadMagnets();
  const plan = await planCta({
    productionItemId,
    channel,
    utmCampaign: item.utmCampaign ?? null,
    postBody,
    pillarTitle,
    formatInstructions,
    leadMagnets,
  });

  return buildDestinationUrl(plan.targetUrl, channel, item.utmCampaign ?? null);
}

// ── Destination URL construction (pure, unit-tested) ───────────────────────
// Appends utm_source (always) and utm_campaign (when present) to the chosen
// target URL. Uses the URL API so existing query params are preserved and
// separators (?/&) are always correct.
export function buildDestinationUrl(
  targetUrl: string,
  channel: string,
  utmCampaign: string | null,
): string {
  try {
    const u = new URL(targetUrl);
    u.searchParams.set("utm_source", channel);
    if (utmCampaign && utmCampaign.trim()) {
      u.searchParams.set("utm_campaign", utmCampaign.trim());
    }
    return u.toString();
  } catch {
    // targetUrl wasn't absolute/parseable — fall back to manual append so we
    // still produce a usable link rather than throwing mid-generation.
    const sep = targetUrl.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ utm_source: channel });
    if (utmCampaign && utmCampaign.trim()) {
      params.set("utm_campaign", utmCampaign.trim());
    }
    return `${targetUrl}${sep}${params.toString()}`;
  }
}

// ── Tracking-link minting (one per post) ───────────────────────────────────
async function mintTrackedLink(args: {
  productionItemId: string;
  destinationUrl: string;
  channel: string;
  utmCampaign: string | null;
  targetType: ShortLinkTargetType;
  leadMagnetId: number | null;
}): Promise<string> {
  const association = {
    contentSource: "hubandspoke",
    contentExternalId: args.productionItemId,
    leadMagnetId: args.leadMagnetId,
    targetType: args.targetType,
    channel: args.channel,
    utmCampaign: args.utmCampaign,
  };

  // Reuse the existing link for this post if one was already minted (one link
  // per post). Prefer an active link; fall back to any.
  const existing = await findShortLinksByContent(args.productionItemId);
  const reuse = existing.find((l) => !l.archived) ?? existing[0];
  if (reuse) {
    await updateShortLink(reuse.slug, {
      destinationUrl: args.destinationUrl,
      archived: false,
      ...association,
    });
    await persistSlug(args.productionItemId, reuse.slug);
    return reuse.slug;
  }

  // First CTA for this post — generate a fresh unique slug, retrying on the
  // rare slug collision (409).
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    try {
      await createShortLink({
        slug,
        destinationUrl: args.destinationUrl,
        ...association,
      });
      await persistSlug(args.productionItemId, slug);
      return slug;
    } catch (err) {
      if (err instanceof ShortLinksApiError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error("tracked-cta: could not mint a unique short-link slug");
}

function generateSlug(): string {
  return `cta-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

async function persistSlug(productionItemId: string, slug: string): Promise<void> {
  await db
    .update(productionItems)
    .set({ shortLinkSlug: slug, updatedAt: new Date() })
    .where(eq(productionItems.id, productionItemId));
}

// ── The LLM target-selection + copy step ───────────────────────────────────
const SYSTEM_PROMPT = `You write the reply CTA that sits underneath a Starter Story social post (X / LinkedIn / Threads / YouTube Community). Starter Story turns long-form founder interviews into posts and drives readers to our lead magnets (free reports / playbooks) or to the specific episode a post is about.

HOUSE STYLE (match the exemplars — they are REAL published CTAs, copy their voice):
- The CTA is ONE short line of copy that ENDS WITH A COLON, then the link on the next line.
- You write ONLY that one line (the "copyLine"); the link is attached automatically. Do NOT include any URL in copyLine.
- Pat's voice: casual and FIRST-PERSON ("i made", "I created this list", "Forgot to say, but…"). Often opens with a throwaway connector like "Btw,", "oh and btw", or "Forgot to say, but".
- ALWAYS tie the line back to what the post was about ("like this one", "solo devs doing cool stuff like this"). For an episode, name the guest ("…watch the whole episode with Brian here:").
- No hashtags, no emoji. A lowercase "i" is fine — keep it casual, not corporate.

TARGET SELECTION (episode-first, lead-magnet fallback):
1. If the post is about a SPECIFIC guest / founder / company, link to THAT episode. Use the find_episode tool with the guest or company name (or the pillar title) to look it up, then use the returned url as target_url with target_type "episode".
2. Otherwise, pick the single best-matching LEAD MAGNET from the list provided for the post's topic. Use its url as target_url, target_type "lead_magnet", and set lead_magnet_id.
3. If the FORMAT SKILL specifies an explicit CTA link or copy, follow the Skill — it wins. Use target_type "custom" with that url when it's neither a listed lead magnet nor an episode.

Call propose_cta exactly once with: copy_line, target_type, target_url, and lead_magnet_id (only when target_type is "lead_magnet"). Never reply with plain text.`;

async function planCta(
  args: GenerateTrackedCtaArgs & { leadMagnets: LeadMagnet[] },
): Promise<CtaPlan> {
  const client = new Anthropic();
  const channel = args.channel as CtaChannel;

  const tools: Anthropic.Tool[] = [
    {
      name: "find_episode",
      description:
        "Search Starter Story's published episodes/case studies by guest name, company, or topic. Returns candidates with their canonical URL. Use when the post is about a specific guest/founder/company.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Guest name, company name, or topic to search for.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "propose_cta",
      description: "Submit the final CTA plan.",
      input_schema: {
        type: "object",
        properties: {
          copy_line: {
            type: "string",
            description:
              "The one-line CTA copy, ending with a colon. No URL in this text.",
          },
          target_type: {
            type: "string",
            enum: ["lead_magnet", "episode", "custom"],
          },
          target_url: {
            type: "string",
            description: "The destination URL (without UTM params).",
          },
          lead_magnet_id: {
            type: ["integer", "null"],
            description:
              "The id of the chosen lead magnet when target_type is lead_magnet; otherwise null.",
          },
        },
        required: ["copy_line", "target_type", "target_url"],
      },
    },
  ];

  const leadMagnetLines = args.leadMagnets
    .filter((m) => m.url)
    .map(
      (m) =>
        `- id=${m.id} | ${m.title ?? m.src ?? "(untitled)"} | ${m.url}${m.description ? ` | ${truncate(m.description, 160)}` : ""}`,
    )
    .join("\n");

  const userPayload = [
    `## CHANNEL`,
    `${args.channel} (sets utm_source on the link; do not mention it in the copy)`,
    ``,
    `## POST BODY (what this CTA replies to)`,
    args.postBody?.trim() || "(post body unavailable)",
    ``,
    `## PILLAR / EPISODE TITLE`,
    args.pillarTitle ?? "(unknown)",
    ``,
    `## LEAD MAGNETS (choose one when the post is not about a specific guest)`,
    leadMagnetLines || "(none available)",
    ``,
    `## STYLE EXEMPLARS (match this voice; copyLine ends with a colon)`,
    renderCtaExemplars(channel),
    ``,
    args.formatInstructions
      ? [
          `## FORMAT SKILL (overrides the defaults when it specifies a CTA)`,
          `Extract only CTA-relevant guidance (link template, copy, episode directive); ignore admin noise.`,
          ``,
          args.formatInstructions,
        ].join("\n")
      : `## FORMAT SKILL\n(none set)`,
    ``,
    `## TASK`,
    `Decide the best target for this post, then call propose_cta once.`,
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: userPayload }] },
  ];

  const MAX_ITERATIONS = 4;
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
      return validatePlan(propose.input, args.leadMagnets);
    }

    if (toolUses.length === 0) {
      throw new Error(
        `tracked-cta: model stopped without proposing a cta (stop_reason=${response.stop_reason})`,
      );
    }

    // Service the find_episode calls (and surface an error for anything else,
    // nudging the model back to propose_cta).
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === "find_episode") {
        const query = String((tu.input as { query?: unknown })?.query ?? "").trim();
        let content = "[]";
        try {
          const episodes = await searchContent({ q: query, limit: 5 });
          content = JSON.stringify(
            episodes.map((e) => ({
              title: e.title,
              url: e.url,
              business_name: e.businessName,
              summary: e.summary ? truncate(e.summary, 200) : null,
            })),
          );
        } catch {
          content = JSON.stringify({ error: "episode search unavailable" });
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content });
      } else if (tu.name !== "propose_cta") {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: `Unknown tool: ${tu.name}` }),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  throw new Error(
    `tracked-cta: tool loop exceeded ${MAX_ITERATIONS} iterations without a propose_cta call`,
  );
}

function validatePlan(input: unknown, leadMagnets: LeadMagnet[]): CtaPlan {
  const obj = (input ?? {}) as Record<string, unknown>;
  const copyLine = typeof obj.copy_line === "string" ? obj.copy_line.trim() : "";
  const targetTypeRaw = String(obj.target_type ?? "");
  const targetUrl = typeof obj.target_url === "string" ? obj.target_url.trim() : "";

  if (!copyLine) throw new Error("tracked-cta: propose_cta returned empty copy_line");
  if (!targetUrl) throw new Error("tracked-cta: propose_cta returned empty target_url");

  const targetType: ShortLinkTargetType =
    targetTypeRaw === "episode" || targetTypeRaw === "custom"
      ? targetTypeRaw
      : "lead_magnet";

  let leadMagnetId: number | null = null;
  if (targetType === "lead_magnet") {
    const raw = obj.lead_magnet_id;
    const id = typeof raw === "number" ? raw : Number(raw);
    // Only trust an id that actually exists in the catalog we provided.
    leadMagnetId =
      Number.isFinite(id) && leadMagnets.some((m) => m.id === id) ? id : null;
  }

  return { copyLine, targetType, targetUrl, leadMagnetId };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
