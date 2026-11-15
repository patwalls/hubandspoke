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

/** Longest on-screen title kept; editors' own lines run 20–50 characters. */
export const MAX_TITLE_CHARS = 60;

/** The writer's on-screen title, cleaned, or null when missing / too long. */
export function cleanOnScreenTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim().replace(/^["“']+|["”']+$/g, "").trim();
  if (!t || t.length > MAX_TITLE_CHARS) return null;
  return t;
}

/** The writer's ask when this format's editors retitle (hooks-learn M3). */
export function onScreenTitleBlock(): string {
  return [
    `ON-SCREEN TITLE — this format's editors hide the long hook and put a short title on screen instead (see the pairs above). Also return \`onScreenTitle\`: 3–8 words, under ${MAX_TITLE_CHARS} characters, the topic of THIS section the way those editors title it (e.g. "Why cold email still works"). No emoji, no trailing colon. The \`hook\` stays the full narrator line.`,
  ].join("\n");
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

/** The format page's view of it (hooks-learn M2): how many of the format's
 *  edited clips shipped their own words instead of the AI hook, and the
 *  pairs new clip ideas learn from. Same pairs the hook writer sees. */
export interface HookRewriteSummary {
  /** Edited clips that started from an AI hook and show words on screen. */
  clips: number;
  /** Of those, how many shipped other words. */
  rewritten: number;
  /** One per distinct shipped line, newest first, capped. */
  pairs: HookRewrite[];
  /** Of `clips`, how many hid the AI hook and showed the editor's own line
   *  instead (hooks-learn M3). */
  retitled: number;
  /** Editors retitle most clips → new clip ideas also get a short on-screen
   *  title and the clip editor starts with it. See `startsWithTitle`. */
  startsWithTitle: boolean;
}

/** Below this many clips a share ("1 of 2") says nothing. */
export const MIN_SUMMARY_CLIPS = 3;

/** The editor hid the AI hook and put their own line on screen instead —
 *  a new title, not a trim of the AI's sentence. */
export function isRetitle(doc: ClipEditDoc): boolean {
  const texts = doc.layers.filter((l): l is TextLayer => l.type === "text");
  const hook = texts.find((l) => l.role === "hook");
  if (!hook || hook.visible) return false;
  return texts.some((l) => l.role === "generic" && l.visible && l.text.trim() !== "");
}

/** At least this share of a format's edited clips retitled → new ideas get a
 *  short on-screen title (hooks-learn M3). Editors on one brand hid the hook
 *  on 4 of 4 hook-v3+ clips; on a brand that keeps the AI hook it was 0 of 5. */
export const RETITLE_SHARE = 0.5;

/** Should new clip ideas of this format carry a short on-screen title? Needs
 *  enough clips to mean something, and most of them retitled. */
export function startsWithTitle(rows: Array<{ aiHook: string | null; doc: ClipEditDoc }>): boolean {
  const counted = rows.filter((r) => r.aiHook?.trim() && shippedHookLine(r.doc) !== null);
  if (counted.length < MIN_SUMMARY_CLIPS) return false;
  return counted.filter((r) => isRetitle(r.doc)).length / counted.length >= RETITLE_SHARE;
}

/** The text a new clip edit's hook layer starts with: the idea's short
 *  on-screen title when it has one, else the AI hook. */
export function startingHookText(idea: { hook: string; onScreenTitle?: string | null }): string {
  const title = idea.onScreenTitle?.replace(/\s+/g, " ").trim();
  return title ? title : idea.hook;
}

/** Null when there are too few clips or editors kept every AI hook. */
export function summarizeHookRewrites(rows: Array<{ aiHook: string | null; doc: ClipEditDoc }>): HookRewriteSummary | null {
  const counted = rows.filter((r) => r.aiHook?.trim() && shippedHookLine(r.doc) !== null);
  if (counted.length < MIN_SUMMARY_CLIPS) return null;
  const rewritten = counted.filter((r) => hookRewrite(r.aiHook, r.doc) !== null).length;
  if (rewritten === 0) return null;
  const retitled = counted.filter((r) => isRetitle(r.doc)).length;
  return { clips: counted.length, rewritten, pairs: collectHookRewrites(counted), retitled, startsWithTitle: startsWithTitle(counted) };
}
