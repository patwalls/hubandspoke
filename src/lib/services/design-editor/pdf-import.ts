/**
 * Import a format template from an uploaded PDF — the worker half (see
 * src/lib/design-editor/pdf-import.ts for the pure normalizer). Reads the
 * `design_template_imports` row, sends the PDF to Claude together with what
 * the editor can draw, the format's Skill and its best published posts (the
 * voice the AI hints should aim for), normalizes the `build_template` call
 * into a DesignDoc and stores it on the row (done | failed). Never touches
 * `formats.design_template` — the user opens the result in the editor and
 * their first edit saves it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designTemplateImports, formats } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { FONT_IDS } from "@/lib/clip-editor/doc";
import { HIGHLIGHT_COLORS } from "@/lib/design-editor/template-fill";
import { IMPORT_TOOL, normalizeImportedTemplate } from "@/lib/design-editor/pdf-import";
import { loadExemplars, type Exemplar } from "./fill-brief";

const MODEL = "claude-opus-5-5";
/** Claude's request ceiling is 32 MB; base64 adds a third. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const SYSTEM_PROMPT = `You turn a designer's PDF (usually a Canva export of an Instagram carousel) into a DESIGN TEMPLATE for our in-app design editor. Every post of the format will be drafted from this template: the AI fills the "ai" text slots from the source video's transcript, the picture slots get stills of the video.

Each PDF page is one slide. Describe every page with build_template: elements back to front, boxes in the PDF's own page units (state the page size you use), origin top-left.

What the editor can draw — use only this:
- text: one font (from the bundled list), size, line height, letter spacing, colour, left/center/right, top/middle/bottom, optional uppercase and a soft drop shadow. Coloured phrases inside the text (highlights) — colour only, no per-word bold/italic/size. Text shrinks to fit its box.
- picture: a photo box (cover-fitted). slot "photo" = THE best founder/guest shot (use it for the single most important picture, usually the cover — at most once or twice); "frame" = a different still of the video per box (every other photo area); "placeholder" = a logo/graphic/screenshot the user will swap in.
- rect: a flat or linearly-faded box (fill → gradientTo, down or up). Use it for dark fades under text over photos, colour bands, cards. No radial gradients: approximate with a linear fade or a flat colour.
- video: a clip of the source video (one per page at most) — only if the PDF clearly marks a slide as video.
- channel: the brand's avatar + name + follower count row, if the design shows one.

How to read the design:
- Placeholder copy (in [brackets], "Lorem ipsum", "Your headline here", instructions like "keep it to two lines") marks an AI slot: slot "ai", text = the placeholder with brackets removed (it becomes the style example — keep its length), hint = a specific instruction for writing it from the transcript every post (role on the slide, length in words, tone, what to highlight and in which colour). If the PDF wrote an instruction, build on it.
- Real fixed copy (a CTA like "Watch the full episode", a sign-off, a handle) is "static".
- Labels that only describe what goes in a picture area ("PHOTO · GUEST CLOSE-UP") are NOT text elements: turn the area into a picture element and put the label's meaning in its name ("Photo · guest close-up").
- Dashed guide lines, crop marks and other designer annotations are not part of the design — skip them.
- Highlighted words in the sample: list them as highlights with their colour. Our standard highlight colours are ${Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => `${k} ${v}`).join(", ")} — use the nearest one unless the design's colour is clearly different.
- Fonts: pick the closest from ${FONT_IDS.join(", ")}. Geometric sans (Poppins, Montserrat regular) → inter-regular for body copy; condensed heavy caps → anton or bebas-neue.
- A photo with text over it needs a fade rect between them (transparent at the top → near-black ~0.85 under the text) so the text reads on any picture.

Write hints that make every post good: verbatim lines from the episode when the design is a quote format, the exact numbers, short. Match the voice of the format's past posts when they are given. Then add a one-or-two-sentence note on what you couldn't reproduce.

Call build_template exactly once.`;

function contextBlock(format: { name: string; brand: string; skill: string | null }, exemplars: Exemplar[]): string {
  const parts = [`## FORMAT\nName: ${format.name}\nBrand: ${format.brand}`];
  if (format.skill?.trim()) parts.push(`## FORMAT SKILL\n${format.skill.trim().slice(0, 4000)}`);
  if (exemplars.length > 0) {
    parts.push(
      "## PAST POSTS OF THIS FORMAT (best first) — the voice the AI hints should aim for\n" +
        exemplars.map((e, i) => `${i + 1}. HEADLINE: ${e.hook}${e.views ? ` (${e.views.toLocaleString()} views)` : ""}${e.caption ? `\n   CAPTION: ${e.caption.replace(/\s+/g, " ").slice(0, 400)}` : ""}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

async function callModel(client: Anthropic, pdfBase64: string, context: string, retryError: string | null): Promise<{ input: unknown } | { error: string }> {
  const content: Anthropic.ContentBlockParam[] = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: context },
  ];
  if (retryError) content.push({ type: "text", text: `A previous attempt produced an invalid template (${retryError}). Be careful with page size, boxes and hex colours.` });
  content.push({ type: "text", text: "Build the template now with build_template." });
  try {
    const message = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: SYSTEM_PROMPT,
        tools: [IMPORT_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content }],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") return { error: "The model declined to read this PDF" };
    if (message.stop_reason === "max_tokens") return { error: "The design was too big to describe in one go" };
    const call = message.content.find((b) => b.type === "tool_use" && b.name === IMPORT_TOOL.name);
    if (!call || call.type !== "tool_use") return { error: "The model didn't return a template" };
    return { input: call.input };
  } catch (err) {
    if (err instanceof Anthropic.APIError) return { error: `Claude API error ${err.status ?? ""}: ${err.message}`.trim() };
    throw err;
  }
}

async function finish(importId: string, patch: { status: "done" | "failed"; doc?: unknown; notes?: string | null; error?: string | null }) {
  await db
    .update(designTemplateImports)
    .set({ status: patch.status, doc: (patch.doc ?? null) as never, notes: patch.notes ?? null, error: patch.error ?? null, updatedAt: sql`now()` })
    .where(eq(designTemplateImports.id, importId));
}

/** Run one import. Idempotent: a row that is already done/failed is left alone. */
export async function runTemplateImport(importId: string, opts: { client?: Anthropic; log?: (msg: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const [row] = await db.select().from(designTemplateImports).where(eq(designTemplateImports.id, importId)).limit(1);
  if (!row || row.status !== "pending") return log(`design-template-import: ${importId} is ${row?.status ?? "missing"}; skipping`);
  const [format] = await db.select({ name: formats.name, brand: formats.brand, skill: formats.instructions }).from(formats).where(and(eq(formats.id, row.formatId))).limit(1);
  if (!format) return finish(importId, { status: "failed", error: "The format no longer exists" });

  const res = await fetch(await getPresignedGetUrl(row.s3Key, 900, { bucket: row.s3Bucket ?? undefined }));
  if (!res.ok) return finish(importId, { status: "failed", error: `Couldn't read the uploaded PDF (${res.status})` });
  const pdfBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");

  const exemplars = await loadExemplars(format.brand ?? "", format.name, null);
  const context = contextBlock({ name: format.name, brand: format.brand ?? "", skill: format.skill }, exemplars);
  const client = opts.client ?? new Anthropic();

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const out = await callModel(client, pdfBase64, context, lastError);
    log(`design-template-import: ${importId} attempt ${attempt} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if ("error" in out) {
      lastError = out.error;
      continue;
    }
    const normalized = normalizeImportedTemplate(out.input);
    if (normalized.ok) return finish(importId, { status: "done", doc: normalized.doc, notes: normalized.notes || null });
    lastError = normalized.error;
  }
  return finish(importId, { status: "failed", error: lastError ?? "Import failed" });
}
