/**
 * The AI half of the design editor: given a format TEMPLATE's slots
 * (template-fill.ts → listSlots), the source video's transcript (with
 * speakers), the format's Skill and the brand's best past posts of the
 * format, write every slot — the texts (with phrases to colour), which
 * moments to clip, and the caption. Design is not its job: the template
 * owns the layout and `fillTemplate` puts the values in.
 *
 * Opus 5 (adaptive thinking): one judgment-heavy call per post that decides
 * whether the post works; past-post exemplars are the style anchor the same
 * way derivative-hook.ts uses them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import type { DesignDoc } from "@/lib/design-editor/doc";
import { HIGHLIGHT_COLORS, listSlots, type DesignFill, type DesignFillValue, type DesignSlotSpec, type HighlightColor } from "@/lib/design-editor/template-fill";

const MODEL = "claude-opus-5";
const TRANSCRIPT_CHAR_BUDGET = 60_000;
const MAX_EXEMPLARS = 8;
const MIN_CLIP_SEC = 12;
const MAX_CLIP_SEC = 75;

export interface GenerateFillArgs {
  productionItemId: string;
  template: DesignDoc;
  /** Free-text steer from the user ("focus on the pricing strategy"). */
  instruction?: string | null;
  client?: Anthropic;
}

export type GenerateFillResult =
  | { ok: true; fill: DesignFill; usage: { input: number; output: number } }
  | { ok: false; failure: { reason: "no-transcript" | "no-item" | "no-slots" | "llm-error" | "llm-no-tool-call"; message?: string } };

const SYSTEM_PROMPT = `You write Starter Story's Instagram carousel posts by filling a DESIGN TEMPLATE. The template is a sequence of slides; each slot below is one thing on a slide — its name, what it's for, the example text the template currently shows (match its length, case and energy), and how much room it has.

You are given the full transcript of the source video (speakers labelled when known), the format's Skill, and the brand's best-performing past posts of this format as the style anchor.

RULES
- Every number, name, tool and tactic must come from the transcript. Never invent figures. If the founder never states a number, use a non-revenue stat they DID state.
- Respect each slot's room: the maxChars figure is a hard ceiling. Shorter than the example is fine; longer is not.
- Highlights: only where a slot lists allowed colours, and only exact substrings of that slot's text. Red = the pain/contrast/surprising claim, green = the win/number, yellow = emphasis.
- Slots marked "leave empty if…" are optional: omit them (do not return a value) when the condition holds. Every other slot must be filled.
- Clips: startSec/endSec are seconds from the start of the video, taken from the [MM:SS] timestamps. Start at the beginning of a sentence. 20–60 seconds. Two clips must not overlap.
- caption: 2–4 short paragraphs in the brand's voice from the past captions, ends with a CTA to the full video. No hashtags unless the past captions use them.
- Match the past posts' voice, punctuation and energy. Plain ASCII apostrophes and quotes. The arrow character → is fine.

Never respond with plain text. Always call fill_design exactly once.`;

const TOOL: Anthropic.Tool = {
  name: "fill_design",
  description: "Return a value for every slot of the template, plus the caption.",
  input_schema: {
    type: "object" as const,
    properties: {
      values: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "The slot's key, exactly as listed." },
            text: { type: "string", description: "For text slots." },
            highlights: {
              type: "array",
              items: {
                type: "object",
                properties: { phrase: { type: "string", description: "An exact substring of text." }, color: { type: "string", enum: ["red", "green", "yellow"] } },
                required: ["phrase", "color"],
              },
            },
            startSec: { type: "number", description: "For clip slots: seconds from the start of the video." },
            endSec: { type: "number", description: "For clip slots." },
          },
          required: ["key"],
        },
      },
      caption: { type: "string" },
    },
    required: ["values", "caption"],
  },
};

interface Exemplar {
  hook: string | null;
  caption: string | null;
  views: number | null;
}

async function loadExemplars(brand: string, formatName: string, excludeItemId: string): Promise<Exemplar[]> {
  const rows = await db
    .select({ hook: productionItems.hook, views: productionItems.views, content: contentDrafts.content })
    .from(productionItems)
    .leftJoin(contentDrafts, and(eq(contentDrafts.productionItemId, productionItems.id), eq(contentDrafts.isCurrent, true)))
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
    caption: typeof (r.content as { caption?: unknown } | null)?.caption === "string" ? (r.content as { caption: string }).caption : null,
  }));
}

export function describeSlots(slots: DesignSlotSpec[]): string {
  return slots
    .map((s) => {
      const where = `slide ${s.pageIndex + 1}`;
      if (s.kind === "video") return `- key "${s.key}" — CLIP (${where}), "${s.name}": ${s.hint}`;
      const colors = s.highlightColors.length ? ` Highlight colours allowed: ${s.highlightColors.join(", ")}.` : "";
      return `- key "${s.key}" — TEXT (${where}), "${s.name}": ${s.hint} Example: "${s.sample.replace(/\s+/g, " ").slice(0, 300)}". maxChars: ${s.maxChars}.${colors}`;
    })
    .join("\n");
}

export function buildFillPrompt(args: {
  title: string | null;
  formatName: string;
  skill: string | null;
  exemplars: Exemplar[];
  transcript: string;
  slots: DesignSlotSpec[];
  instruction: string | null;
}): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  blocks.push({ type: "text", text: `## SOURCE VIDEO\nTitle: ${args.title ?? "(untitled)"}\nFormat: ${args.formatName}` });
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
  blocks.push({ type: "text", text: `## SLOTS TO FILL\n${describeSlots(args.slots)}` });
  blocks.push({ type: "text", text: `## TRANSCRIPT\n${args.transcript.slice(0, TRANSCRIPT_CHAR_BUDGET)}` });
  if (args.instruction?.trim()) blocks.push({ type: "text", text: `## INSTRUCTION FROM THE EDITOR (follow this)\n${args.instruction.trim().slice(0, 1000)}` });
  blocks.push({ type: "text", text: "Fill the template now. Call fill_design exactly once." });
  return blocks;
}

/** "12:34" / "1:02:03" / "83" → seconds (models sometimes answer in MM:SS). */
export function parseTimestamp(v: string): number | null {
  const parts = v.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Validate the tool call against the slots: unknown keys dropped, text
 *  trimmed to the slot's room, clips clamped to 12–75s. */
export function coerceFill(raw: unknown, slots: DesignSlotSpec[]): DesignFill | null {
  const r = raw as { values?: unknown; caption?: unknown };
  const byKey = new Map(slots.map((s) => [s.key, s]));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? parseTimestamp(v) : null);
  const values: DesignFillValue[] = [];
  for (const v of Array.isArray(r.values) ? r.values : []) {
    const item = v as { key?: unknown; text?: unknown; highlights?: unknown; startSec?: unknown; endSec?: unknown };
    const slot = typeof item.key === "string" ? byKey.get(item.key) : undefined;
    if (!slot) continue;
    if (slot.kind === "text") {
      const text = typeof item.text === "string" ? item.text.trim().replace(/-?&gt;|->|=>/g, "→").slice(0, Math.max(slot.maxChars ?? 400, 40) * 2) : "";
      if (!text) continue;
      const highlights = Array.isArray(item.highlights)
        ? item.highlights
            .map((h) => {
              const hh = h as { phrase?: unknown; color?: unknown };
              const color = typeof hh.color === "string" && hh.color in HIGHLIGHT_COLORS ? (hh.color as HighlightColor) : null;
              return typeof hh.phrase === "string" && color && slot.highlightColors.includes(color) ? { phrase: hh.phrase.slice(0, 160), color } : null;
            })
            .filter((h): h is NonNullable<typeof h> => !!h)
            .slice(0, 4)
        : [];
      values.push({ key: slot.key, text, highlights });
    } else {
      const start = num(item.startSec);
      const end = num(item.endSec);
      if (start === null || end === null) continue;
      const s0 = Math.max(0, start);
      const e0 = Math.min(Math.max(end, s0 + MIN_CLIP_SEC), s0 + MAX_CLIP_SEC);
      values.push({ key: slot.key, startSec: s0, endSec: e0 });
    }
  }
  const caption = typeof r.caption === "string" ? r.caption.trim().slice(0, 2200) : "";
  if (values.length === 0) return null;
  return { caption, values };
}

export async function generateDesignFill(args: GenerateFillArgs): Promise<GenerateFillResult> {
  const slots = listSlots(args.template);
  if (slots.length === 0) return { ok: false, failure: { reason: "no-slots", message: "The template has no AI slots" } };
  const [item] = await db
    .select({ id: productionItems.id, title: productionItems.title, brand: productionItems.brand, format: productionItems.format, pillarContentItemId: productionItems.pillarContentItemId })
    .from(productionItems)
    .where(eq(productionItems.id, args.productionItemId))
    .limit(1);
  if (!item) return { ok: false, failure: { reason: "no-item" } };

  const sourceId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(sourceId);
  if (!transcript || !transcript.fullText.trim()) return { ok: false, failure: { reason: "no-transcript" } };

  const formatName = item.format ?? "";
  const [format] = await db.select({ skill: formats.instructions }).from(formats).where(and(eq(formats.brand, item.brand ?? ""), eq(formats.name, formatName))).limit(1);
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
      tool_choice: { type: "tool", name: "fill_design" },
      messages: [
        {
          role: "user",
          content: buildFillPrompt({
            title: pillar?.title ?? item.title,
            formatName,
            skill: format?.skill ?? null,
            exemplars,
            transcript: transcript.segmentsMarkdown,
            slots,
            instruction: args.instruction ?? null,
          }),
        },
      ],
    });
  } catch (err) {
    return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
  }

  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "fill_design") continue;
    const fill = coerceFill(block.input, slots);
    if (!fill) return { ok: false, failure: { reason: "llm-no-tool-call", message: "fill incomplete" } };
    return { ok: true, fill, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
  }
  return { ok: false, failure: { reason: "llm-no-tool-call" } };
}
