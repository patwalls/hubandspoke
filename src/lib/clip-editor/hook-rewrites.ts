/**
 * How editors rewrite a format's AI hooks (project "hooks learn", M1).
 *
 * Every clip edit starts with the clip idea's AI hook on screen. On the
 * busiest clip format about half the clips ship with other words: the editor
 * cuts the hook down, or hides it and types their own short line (often a
 * line the guest says in the clip). The clip-idea hook writer gets this
 * format's recent (AI hook → shipped line) pairs so it writes the way the
 * editors ship, not the way they have to fix.
 *
 * Pure: the loader is `services/clip-editor/hook-rewrites.ts`. The words a
 * clip ships with = its visible hook layer, or (hook hidden) the visible
 * text the editor added. A change that only trims emoji, spaces, case or
 * end punctuation is not a rewrite.
 */
import type { ClipEditDoc, TextLayer } from "./doc";

export interface HookRewrite {
  ai: string;
  shipped: string;
}

/** At most this many pairs go into one prompt. */
export const MAX_REWRITES = 8;

/** Folds away what an editor tidies without rewriting: emoji, case,
 *  whitespace and punctuation. Structural, not meaning. */
export function hookKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The words this clip shipped with on screen, or null when it shows none. */
export function shippedHookLine(doc: ClipEditDoc): string | null {
  const texts = doc.layers.filter((l): l is TextLayer => l.type === "text" && l.visible && l.text.trim() !== "");
  const hook = texts.find((l) => l.role === "hook");
  if (hook) return oneLine(hook.text);
  // Hook hidden: the editor's own lines, top to bottom, each once.
  const own = [...new Set(texts.filter((l) => l.role === "generic").sort((a, b) => a.yPct - b.yPct).map((l) => oneLine(l.text)))];
  return own.length ? own.join(" / ") : null;
}

/** The pair this clip makes, or null when the editor kept the AI's words. */
export function hookRewrite(aiHook: string | null, doc: ClipEditDoc): HookRewrite | null {
  if (!aiHook || !aiHook.trim()) return null;
  const shipped = shippedHookLine(doc);
  if (!shipped) return null;
  if (hookKey(shipped) === hookKey(aiHook)) return null;
  return { ai: oneLine(aiHook), shipped };
}

/** Pairs from clips newest first: one per distinct shipped line, capped. */
export function collectHookRewrites(rows: Array<{ aiHook: string | null; doc: ClipEditDoc }>, max = MAX_REWRITES): HookRewrite[] {
  const out: HookRewrite[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const p = hookRewrite(r.aiHook, r.doc);
    if (!p || seen.has(hookKey(p.shipped))) continue;
    seen.add(hookKey(p.shipped));
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** The hook writer's system-prompt block, or null with no pairs. */
export function hookRewritesBlock(pairs: HookRewrite[]): string | null {
  if (pairs.length === 0) return null;
  const lines = pairs.slice(0, MAX_REWRITES).map((p) => `- AI wrote: "${p.ai}"\n  Editor shipped: "${p.shipped}"`);
  return [
    `HOW EDITORS REWRITE THIS FORMAT'S HOOKS — recent clips where the editor replaced the AI's on-screen hook before posting (newest first):`,
    ``,
    ...lines,
    ``,
    `Write your hook the way they ship it: match their length, voice and kind of line (if they swap a long sentence for a short line the speaker says, do that). Never copy their facts or words into a different clip — each clip's hook comes from its own section. The REFERENCE LIBRARY rule still applies.`,
  ].join("\n");
}
