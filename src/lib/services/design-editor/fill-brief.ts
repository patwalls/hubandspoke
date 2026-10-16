/**
 * The AI half of the design editor: given a format TEMPLATE's slots
 * (template-fill.ts → listSlots), the source video's transcript (with
 * speakers), its description (the founder's links), the format's Skill and
 * the brand's best past posts of the format — headline, slides AND caption,
 * so the model sees how the format is built, not only how it sounds — write
 * every slot: the texts (with phrases to colour), which moments to clip, the
 * caption, and notes for the editor. Design is not its job: the template
 * owns the layout and `fillTemplate` puts the values in.
 *
 * Research: with `research: true` (the worker paths — first draft and
 * regenerate; the in-request hero/cover-style fills leave it off) the model
 * has web search for what the template asks for and the transcript doesn't
 * give — a founder with "28 apps" who never names one (2026-10-16): the
 * video description links their X profile, where the apps are listed. A
 * server tool means `pause_turn` can come back mid-search; the loop resumes
 * it. What was looked up lands in `notes`, with the URL, for the editor.
 *
 * Opus 5.5 (adaptive thinking, effort high): one judgment-heavy call per post that decides
 * whether the post works; past-post exemplars are the style anchor the same
 * way derivative-hook.ts uses them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import type { DesignDoc } from "@/lib/design-editor/doc";
import { HIGHLIGHT_COLORS, listSlots, type DesignFill, type DesignFillValue, type DesignSlotSpec, type HighlightColor } from "@/lib/design-editor/template-fill";

const MODEL = "claude-opus-5-5";
const TRANSCRIPT_CHAR_BUDGET = 60_000;
const DESCRIPTION_CHAR_BUDGET = 1_500;
const MAX_EXEMPLARS = 8;
const MAX_EXEMPLAR_SLIDES = 12;
const EXEMPLAR_SLIDE_CHARS = 260;
const EXEMPLAR_BODY_CHARS = 1_000;
const MIN_CLIP_SEC = 12;
const MAX_CLIP_SEC = 75;
/** Searches / page reads per fill: enough to find a founder's products from
 *  their links, not a crawl (8 searches ran out on the first try, 2026-10-16). */
const MAX_WEB_SEARCHES = 10;
const MAX_WEB_FETCHES = 6;
/** `pause_turn` resumes (the server's search loop pausing) before giving up. */
const MAX_PAUSE_RESUMES = 4;
const NOTES_MAX_CHARS = 1_500;

export interface GenerateFillArgs {
  productionItemId: string;
  template: DesignDoc;
  /** Free-text steer from the user ("focus on the pricing strategy"). */
  instruction?: string | null;
  /** The post's attached ManyChat keyword, so the caption tells readers
   *  to comment it. */
  dmKeyword?: string | null;
  /** Let the model web-search for what the template needs and the
   *  transcript lacks (product names, what each does). Worker paths only —
   *  a research run can outlast Heroku's 30s router limit. */
  research?: boolean;
  client?: Anthropic;
}

export type GenerateFillResult =
  | { ok: true; fill: DesignFill; usage: { input: number; output: number }; searches: number }
  | { ok: false; failure: { reason: "no-transcript" | "no-item" | "no-slots" | "llm-error" | "llm-no-tool-call"; message?: string } };

/** `brandLabel` = the brand's display name ("Starter Story", "My First Million"). */
export const systemPrompt = (brandLabel: string, research: boolean) => `You write ${brandLabel}'s Instagram carousel posts by filling a DESIGN TEMPLATE. The template is a sequence of slides; each slot below is one thing on a slide — its name, what it's for, the example text the template currently shows (match its length, case and energy), and how much room it has.

You are given the full transcript of the source video (speakers labelled when known), the video's description (with the founder's links), the format's Skill, and the brand's best-performing past posts of this format — their headline, their slides and their caption — as the anchor for voice AND for how the format is built.

RULES
- Every number, name, tool and tactic must be TRUE: from the transcript${research ? ", or from a page about THIS founder that you looked up" : ""}. Never invent figures. If the founder never states a number, use a non-revenue stat they DID state.
${research ? `- Look things up when the template asks for something the transcript doesn't give — the names of the founder's apps / products / sites and what each one does, their website, a figure the founder only alludes to. Start from the founder's own links in the video description (their X/Twitter, website, App Store or Product Hunt page) or their name plus what they build; open a page (web_fetch) when the search snippet only says it exists — a profile's pinned links, an App Store developer page listing every app; stop once the slots have what they need — a handful of lookups, not a crawl. Use only what a page clearly ties to THIS founder: a namesake's product is worse than an empty slot. Say what you looked up, with the URL, in notes.
` : ""}- One thing per slide: when the template repeats a slide per item (one slide per app, per product, per story beat, per quote), each slide is ONE item — named, with its own facts — the way the past posts' slides do it. Pick the items the founder names or gives numbers for, in the founder's order, up to the number of slides; never merge the items into one summary slide. A founder with fewer items than slides leaves the extra slides empty.
- Respect each slot's room: the maxChars figure is a hard ceiling. Shorter than the example is fine; longer is not.
- Highlights: only where a slot lists allowed colours, and only exact substrings of that slot's text. Red = the pain/contrast/surprising claim, green = the win/number, yellow = emphasis.
- Slots marked "leave empty if…" are optional: omit them (do not return a value) when the condition holds. Every other slot must be filled.
- Clips: startSec/endSec are seconds from the start of the video, taken from the [MM:SS] timestamps. Start at the beginning of a sentence. 20–60 seconds. Two clips must not overlap.
- caption: 2–4 short paragraphs in the brand's voice from the past captions, ends with a CTA to the full video. No hashtags unless the past captions use them.
- notes: 1–4 short lines for the editor — ${research ? "what you looked up (with the URL), " : ""}slides you left empty and why, what they must add by hand (a screenshot, a name the video never gives). Empty when there is nothing to say.
- Match the past posts' voice, punctuation and energy. Plain ASCII apostrophes and quotes. The arrow character → is fine.

Never respond with plain text. Always finish by calling fill_design exactly once.`;

const TOOL: Anthropic.Tool = {
  name: "fill_design",
  description: "Return a value for every slot of the template, plus the caption and notes for the editor.",
  // Opus 5.5 rejects forced tool_choice; strict keeps the schema-valid
  // arguments the forced call guaranteed (every object needs
  // additionalProperties: false).
  strict: true,
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
                additionalProperties: false,
              },
            },
            startSec: { type: "number", description: "For clip slots: seconds from the start of the video." },
            endSec: { type: "number", description: "For clip slots." },
          },
          required: ["key"],
          additionalProperties: false,
        },
      },
      caption: { type: "string" },
      notes: { type: "string", description: "Short lines for the editor: what was looked up (with URLs), slides left empty and why, what to add by hand. Empty string when there is nothing to say." },
    },
    required: ["values", "caption"],
    additionalProperties: false,
  },
};

/** Web search + web fetch, the `_20260209` variants for Opus 5.5 (dynamic
 *  filtering runs code execution under the hood — never declare
 *  code_execution beside them). Fetch opens pages already in the
 *  conversation: the description's links and search results — a founder's
 *  profile or site, where the search snippet only says it exists. */
const WEB_SEARCH = { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: MAX_WEB_SEARCHES };
const WEB_FETCH = { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: MAX_WEB_FETCHES };

export interface Exemplar {
  hook: string | null;
  caption: string | null;
  views: number | null;
  /** The post's slides, in order (the carousel's text per slide). */
  slides: string[];
  /** The post's body copy when the draft has no slides (an X / LinkedIn
   *  post of the format). */
  body: string | null;
}

/** The parts of a content draft a later post learns the format from. The
 *  draft's shape depends on the platform: `slides[{text, order}]` + `caption`
 *  for a carousel, `body` / `post` + `cta` for a text post. */
export function exemplarContent(content: unknown): Pick<Exemplar, "caption" | "slides" | "body"> {
  const c = (content ?? {}) as { caption?: unknown; slides?: unknown; body?: unknown; post?: unknown };
  const slides = Array.isArray(c.slides)
    ? [...(c.slides as Array<{ text?: unknown; order?: unknown }>)]
        .sort((a, b) => (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0))
        .map((s) => (typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim() : ""))
        .filter(Boolean)
        .slice(0, MAX_EXEMPLAR_SLIDES)
        .map((t) => t.slice(0, EXEMPLAR_SLIDE_CHARS))
    : [];
  const bodyRaw = typeof c.body === "string" ? c.body : typeof c.post === "string" ? c.post : "";
  const body = slides.length === 0 && bodyRaw.trim() ? bodyRaw.trim().slice(0, EXEMPLAR_BODY_CHARS) : null;
  return { caption: typeof c.caption === "string" && c.caption.trim() ? c.caption : null, slides, body };
}

/** Some hooks were synced as "<format name>: <headline>" — the prefix is
 *  the format's, not the post's voice. */
export function stripFormatPrefix(hook: string, formatName: string): string {
  const prefix = `${formatName.trim().toLowerCase()}:`;
  return formatName.trim() && hook.trim().toLowerCase().startsWith(prefix) ? hook.trim().slice(prefix.length).trim() : hook.trim();
}

export async function loadExemplars(brand: string, formatName: string, excludeItemId: string | null): Promise<Exemplar[]> {
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
        excludeItemId ? ne(productionItems.id, excludeItemId) : undefined,
      ),
    )
    .orderBy(desc(productionItems.views), desc(productionItems.publishedDate))
    .limit(MAX_EXEMPLARS);
  return rows.map((r) => ({ hook: r.hook ? stripFormatPrefix(r.hook, formatName) : null, views: r.views, ...exemplarContent(r.content) }));
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

export function describeExemplars(exemplars: Exemplar[]): string {
  return exemplars
    .map((e, i) => {
      const lines = [`${i + 1}. HEADLINE: ${e.hook}${e.views ? ` (${e.views.toLocaleString()} views)` : ""}`];
      e.slides.forEach((s, n) => lines.push(`   SLIDE ${n + 1}: ${s}`));
      if (e.body) lines.push(`   BODY: ${e.body.replace(/\s+/g, " ")}`);
      if (e.caption) lines.push(`   CAPTION: ${e.caption.replace(/\s+/g, " ").slice(0, 600)}`);
      return lines.join("\n");
    })
    .join("\n");
}

export function buildFillPrompt(args: {
  title: string | null;
  formatName: string;
  /** The source video's description — the founder's links live here. */
  description?: string | null;
  skill: string | null;
  exemplars: Exemplar[];
  transcript: string;
  slots: DesignSlotSpec[];
  instruction: string | null;
  dmKeyword?: string | null;
}): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  blocks.push({ type: "text", text: `## SOURCE VIDEO\nTitle: ${args.title ?? "(untitled)"}\nFormat: ${args.formatName}` });
  if (args.description?.trim()) blocks.push({ type: "text", text: `## VIDEO DESCRIPTION (the founder's links are here)\n${args.description.trim().slice(0, DESCRIPTION_CHAR_BUDGET)}` });
  if (args.skill?.trim()) blocks.push({ type: "text", text: `## FORMAT SKILL\n${args.skill.trim().slice(0, 4000)}` });
  if (args.exemplars.length > 0) {
    blocks.push({ type: "text", text: "## PAST POSTS OF THIS FORMAT (best first) — match this voice and build the slides the way they do\n" + describeExemplars(args.exemplars) });
  }
  blocks.push({ type: "text", text: `## SLOTS TO FILL\n${describeSlots(args.slots)}` });
  blocks.push({ type: "text", text: `## TRANSCRIPT\n${args.transcript.slice(0, TRANSCRIPT_CHAR_BUDGET)}` });
  if (args.dmKeyword?.trim()) blocks.push({ type: "text", text: `## DM KEYWORD\nThis post is wired to ManyChat with the keyword "${args.dmKeyword.trim().toUpperCase()}": the caption's CTA must tell readers to comment "${args.dmKeyword.trim().toUpperCase()}" to get the link DM'd (that is the CTA — not "link in bio"). Never invent a different keyword.` });
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
 *  trimmed to the slot's room, clips clamped to 12–75s, notes trimmed. */
export function coerceFill(raw: unknown, slots: DesignSlotSpec[]): DesignFill | null {
  const r = raw as { values?: unknown; caption?: unknown; notes?: unknown };
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
  const notes = typeof r.notes === "string" ? r.notes.trim().slice(0, NOTES_MAX_CHARS) : "";
  if (values.length === 0) return null;
  return { caption, values, ...(notes ? { notes } : {}) };
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
  const [brandRow] = item.brand ? await db.select({ label: brands.label }).from(brands).where(eq(brands.slug, item.brand)).limit(1) : [];
  const brandLabel = brandRow?.label ?? "the brand";
  const [pillar] = await db.select({ title: productionItems.title, description: productionItems.description }).from(productionItems).where(eq(productionItems.id, sourceId)).limit(1);

  const research = args.research === true;
  const client = args.client ?? new Anthropic();
  const prompt = buildFillPrompt({
    title: pillar?.title ?? item.title,
    formatName,
    description: pillar?.description ?? null,
    skill: format?.skill ?? null,
    exemplars,
    transcript: transcript.segmentsMarkdown,
    slots,
    instruction: args.instruction ?? null,
    dmKeyword: args.dmKeyword ?? null,
  });
  // Opus 5.5 rejects forced tool_choice ("tool"/"any" → 400), so the call
  // runs on "auto" with the prompt naming fill_design — and "auto" doesn't
  // guarantee the call, so retry once with a nudge when it's missing. An
  // incomplete fill (slots missing) gets the same second chance. The
  // conversation is carried forward so a retry keeps what was researched.
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const usage = { input: 0, output: 0 };
  let searches = 0;
  let resumes = 0;
  for (let attempt = 0; attempt < 2; ) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        // With forced tool_choice Opus 5 skipped thinking; on "auto" Opus 5.5
        // thinks first and that counts toward max_tokens — 8000 left too
        // little room. Stays under the SDK's ~21K non-streaming ceiling.
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        // Opus 5.5 defaults to "medium" (Opus 5 was "high"); keep "high".
        output_config: { effort: "high" },
        system: systemPrompt(brandLabel, research),
        tools: research ? [TOOL, WEB_SEARCH, WEB_FETCH] : [TOOL],
        tool_choice: { type: "auto" },
        messages,
      });
    } catch (err) {
      return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
    }
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    // Dynamic filtering adds its own server_tool_use blocks: count the real lookups.
    searches += response.content.filter((b) => b.type === "server_tool_use" && (b.name === "web_search" || b.name === "web_fetch")).length;
    if (response.stop_reason === "refusal") return { ok: false, failure: { reason: "llm-error", message: "The model declined this request" } };
    if (response.stop_reason === "max_tokens") return { ok: false, failure: { reason: "llm-no-tool-call", message: "fill cut off at max_tokens" } };
    // The server's search loop paused mid-turn: send the turn back as is
    // (no user message) and it resumes where it stopped.
    if (response.stop_reason === "pause_turn") {
      if (++resumes > MAX_PAUSE_RESUMES) return { ok: false, failure: { reason: "llm-no-tool-call", message: `research did not finish after ${MAX_PAUSE_RESUMES} resumes` } };
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "fill_design");
    if (call) {
      const fill = coerceFill(call.input, slots);
      if (fill) {
        if (research) console.info(`[design-fill] item=${item.id} searches=${searches} resumes=${resumes} notes=${fill.notes ? JSON.stringify(fill.notes.slice(0, 200)) : "none"}`);
        return { ok: true, fill, usage, searches };
      }
    }
    attempt++;
    if (attempt >= 2) return { ok: false, failure: { reason: "llm-no-tool-call", ...(call ? { message: "fill incomplete" } : {}) } };
    // A tool call must be answered with a tool_result before the nudge.
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        ...(call ? [{ type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: "Nothing usable: no slot received a value." }] : []),
        { type: "text" as const, text: call ? "Your previous fill_design call left every slot empty. Call fill_design again, exactly once, with a value for every slot." : "Your previous reply did not call fill_design. Call fill_design now, exactly once." },
      ],
    });
  }
  return { ok: false, failure: { reason: "llm-no-tool-call" } };
}
