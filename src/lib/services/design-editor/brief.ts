/**
 * The AI half of the design editor: read the source video's transcript (with
 * speakers), the format's Skill, and the brand's best past posts, and write
 * the CONTENT of an "Instagram PLAYBOOK" post — stat, headline, which phrases
 * to highlight, the playbook phases, and the caption. Design is not its job;
 * playbook-template.ts turns this brief into a document.
 *
 * Opus 5 (adaptive thinking): this is one judgment-heavy call per post that
 * decides whether the post works, and past-post exemplars are the style
 * anchor the same way derivative-hook.ts uses them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import type { PlaybookBrief } from "@/lib/design-editor/playbook-template";

const MODEL = "claude-opus-5";
const TRANSCRIPT_CHAR_BUDGET = 60_000;
const MAX_EXEMPLARS = 8;

export interface GenerateBriefArgs {
  productionItemId: string;
  /** Free-text steer from the user ("focus on the pricing strategy",
   *  "make the stat about customer calls"). */
  instruction?: string | null;
  client?: Anthropic;
}

export type GenerateBriefResult =
  | { ok: true; brief: PlaybookBrief; usage: { input: number; output: number } }
  | { ok: false; failure: { reason: "no-transcript" | "no-item" | "llm-error" | "llm-no-tool-call"; message?: string } };

const SYSTEM_PROMPT = `You write Starter Story's "Instagram PLAYBOOK" carousel posts.

The post has two images. IMAGE 1 is the hook: the founder's photo, one huge revenue/traction NUMBER, and an all-caps headline where one or two phrases are highlighted (red for the pain/contrast, green for the win/number). IMAGE 2 looks like a screenshot of an iPhone Notes page: a titled playbook with 3–5 numbered phases, each a bold heading plus a dense, specific paragraph.

You are given the full transcript of the source video (speakers labelled when known), the format's Skill, and the brand's best-performing past posts of this format as the style anchor.

RULES
- Every number, name, tool and tactic must come from the transcript. Never invent figures. If the founder never states a number, use a non-revenue stat they DID state (customers, calls, months, apps).
- The stat is the single most scroll-stopping TRUE number ("$720K", "2,000", "38%") with a short unit ("/year", "customer calls", "profit margin").
- The headline is 10–18 words, first person or third person like the past posts, a before→after contrast that the number pays off. Highlights are EXACT substrings of the headline: one red (the struggle or surprising claim), one green (the outcome/number).
- The playbook must be actionable: each phase is a step a reader could do this week, with the specific tools/tactics/thresholds the founder described. Bodies are 40–90 words. Headings follow "Phase N: <what> — <how>".
- notesTitle names the playbook: "The 3-Phase Customer Call Playbook". footer references it: "See his 3-Phase playbook→" (use her/their to match the founder).
- caption: 2–4 short paragraphs in the brand's voice from the past captions, ends with a CTA to the full video. No hashtags unless the past captions use them.
- Match the past posts' voice, punctuation and energy. Plain ASCII apostrophes and quotes.

Never respond with plain text. Always call write_playbook_brief exactly once.`;

const TOOL: Anthropic.Tool = {
  name: "write_playbook_brief",
  description: "Return the content of the Instagram PLAYBOOK post.",
  input_schema: {
    type: "object" as const,
    properties: {
      stat: { type: "string", description: 'The big number, e.g. "$720K".' },
      statUnit: { type: "string", description: 'What the number is, e.g. "/year".' },
      headline: { type: "string" },
      highlights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            phrase: { type: "string", description: "An exact substring of the headline." },
            color: { type: "string", enum: ["red", "green"] },
          },
          required: ["phrase", "color"],
        },
      },
      footer: { type: "string" },
      notesTitle: { type: "string" },
      phases: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          properties: { heading: { type: "string" }, body: { type: "string" } },
          required: ["heading", "body"],
        },
      },
      caption: { type: "string" },
    },
    required: ["stat", "statUnit", "headline", "highlights", "footer", "notesTitle", "phases", "caption"],
  },
};

interface Exemplar {
  hook: string | null;
  caption: string | null;
  views: number | null;
}

async function loadExemplars(brand: string, formatName: string, excludeItemId: string): Promise<Exemplar[]> {
  const rows = await db
    .select({
      hook: productionItems.hook,
      views: productionItems.views,
      content: contentDrafts.content,
    })
    .from(productionItems)
    .leftJoin(
      contentDrafts,
      and(eq(contentDrafts.productionItemId, productionItems.id), eq(contentDrafts.isCurrent, true)),
    )
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.format, formatName),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.hook),
        sql`length(trim(${productionItems.hook})) > 0`,
        ne(productionItems.id, excludeItemId),
      ),
    )
    .orderBy(desc(productionItems.views), desc(productionItems.publishedDate))
    .limit(MAX_EXEMPLARS);
  return rows.map((r) => ({
    hook: r.hook,
    views: r.views,
    caption: typeof (r.content as { caption?: unknown } | null)?.caption === "string"
      ? ((r.content as { caption: string }).caption)
      : null,
  }));
}

export function buildBriefPrompt(args: {
  title: string | null;
  formatName: string;
  skill: string | null;
  exemplars: Exemplar[];
  transcript: string;
  instruction: string | null;
}): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  blocks.push({
    type: "text",
    text: `## SOURCE VIDEO\nTitle: ${args.title ?? "(untitled)"}\nFormat: ${args.formatName}`,
  });
  if (args.skill?.trim()) blocks.push({ type: "text", text: `## FORMAT SKILL\n${args.skill.trim().slice(0, 4000)}` });
  if (args.exemplars.length > 0) {
    blocks.push({
      type: "text",
      text:
        "## PAST POSTS OF THIS FORMAT (best first) — match this voice\n" +
        args.exemplars
          .map((e, i) => `${i + 1}. HEADLINE: ${e.hook}${e.views ? ` (${e.views.toLocaleString()} views)` : ""}${e.caption ? `\n   CAPTION: ${e.caption.replace(/\s+/g, " ").slice(0, 600)}` : ""}`)
          .join("\n"),
    });
  }
  blocks.push({ type: "text", text: `## TRANSCRIPT\n${args.transcript.slice(0, TRANSCRIPT_CHAR_BUDGET)}` });
  if (args.instruction?.trim()) {
    blocks.push({ type: "text", text: `## INSTRUCTION FROM THE EDITOR (follow this)\n${args.instruction.trim().slice(0, 1000)}` });
  }
  blocks.push({ type: "text", text: "Write the post now. Call write_playbook_brief exactly once." });
  return blocks;
}

function coerceBrief(raw: unknown): PlaybookBrief | null {
  const b = raw as Partial<Record<keyof PlaybookBrief, unknown>>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const phases = Array.isArray(b.phases)
    ? b.phases
        .map((p) => ({ heading: str((p as { heading?: unknown }).heading, 120), body: str((p as { body?: unknown }).body, 900) }))
        .filter((p) => p.heading && p.body)
        .slice(0, 5)
    : [];
  const highlights = Array.isArray(b.highlights)
    ? b.highlights
        .map((h) => ({ phrase: str((h as { phrase?: unknown }).phrase, 120), color: (h as { color?: unknown }).color === "red" ? ("red" as const) : ("green" as const) }))
        .filter((h) => h.phrase)
        .slice(0, 4)
    : [];
  const brief: PlaybookBrief = {
    stat: str(b.stat, 16),
    statUnit: str(b.statUnit, 40),
    headline: str(b.headline, 200),
    highlights,
    // Models sometimes escape or ASCII-fy the arrow ("-&gt;", "->").
    footer: (str(b.footer, 80) || "See the full playbook→").replace(/-?&gt;|->|=>/g, "→"),
    notesTitle: str(b.notesTitle, 90),
    phases,
    caption: str(b.caption, 2200),
  };
  if (!brief.stat || !brief.headline || !brief.notesTitle || brief.phases.length < 2) return null;
  return brief;
}

export async function generatePlaybookBrief(args: GenerateBriefArgs): Promise<GenerateBriefResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      format: productionItems.format,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.productionItemId))
    .limit(1);
  if (!item) return { ok: false, failure: { reason: "no-item" } };

  const sourceId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(sourceId);
  if (!transcript || !transcript.fullText.trim()) return { ok: false, failure: { reason: "no-transcript" } };

  const formatName = item.format ?? "Instagram PLAYBOOK";
  const [format] = await db
    .select({ skill: formats.instructions })
    .from(formats)
    .where(and(eq(formats.brand, item.brand ?? ""), eq(formats.name, formatName)))
    .limit(1);
  const exemplars = await loadExemplars(item.brand ?? "", formatName, item.id);
  const [pillar] = item.pillarContentItemId
    ? await db.select({ title: productionItems.title }).from(productionItems).where(eq(productionItems.id, item.pillarContentItemId)).limit(1)
    : [{ title: item.title }];

  const client = args.client ?? new Anthropic();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "write_playbook_brief" },
      messages: [
        {
          role: "user",
          content: buildBriefPrompt({
            title: pillar?.title ?? item.title,
            formatName,
            skill: format?.skill ?? null,
            exemplars,
            transcript: transcript.segmentsMarkdown,
            instruction: args.instruction ?? null,
          }),
        },
      ],
    });
  } catch (err) {
    return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
  }

  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "write_playbook_brief") continue;
    const brief = coerceBrief(block.input);
    if (!brief) return { ok: false, failure: { reason: "llm-no-tool-call", message: "brief incomplete" } };
    return {
      ok: true,
      brief,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  }
  return { ok: false, failure: { reason: "llm-no-tool-call" } };
}
