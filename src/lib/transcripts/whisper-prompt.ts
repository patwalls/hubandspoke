/**
 * Compose the `prompt` sent to Whisper for one audio chunk (fix-names-once M4).
 *
 * Whisper reads the prompt as "text that came before" and leans toward the
 * spellings in it, so three parts share its ~224-token budget:
 *   1. the item line (title, author, description snippet),
 *   2. the brand's names — spellings the team fixed by hand in recent clips
 *      of this brand (`loadBrandVocabulary`), so the next video is
 *      transcribed with them instead of being corrected clip after clip,
 *   3. the tail of the previous chunk, for continuity.
 *
 * Each part has its own ceiling so one can't crowd out the others: the
 * vocabulary keeps whole names (never half a word), the continuation keeps
 * its END (the words right before this chunk), and the item line keeps its
 * START (the title).
 */

export const PROMPT_MAX_CHARS = 800;
export const PROMPT_CONTINUATION_CHARS = 300;
export const PROMPT_VOCABULARY_CHARS = 200;

/** "Names: ChatGPT, Rork, Abmaxx." — whole names only, within the budget. */
export function vocabularyLine(names: string[], maxChars = PROMPT_VOCABULARY_CHARS): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let len = "Names: .".length;
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    const add = (kept.length > 0 ? 2 : 0) + name.length;
    if (len + add > maxChars) continue;
    seen.add(key);
    kept.push(name);
    len += add;
  }
  return kept.length > 0 ? `Names: ${kept.join(", ")}.` : "";
}

export function composeWhisperPrompt(parts: {
  item: string;
  vocabulary?: string[];
  continuation?: string;
}): string {
  const vocab = vocabularyLine(parts.vocabulary ?? []);
  const tail = (parts.continuation ?? "").trim().slice(-PROMPT_CONTINUATION_CHARS).trim();
  const used = (vocab ? vocab.length + 1 : 0) + (tail ? tail.length + 1 : 0);
  const item = parts.item.trim().slice(0, Math.max(0, PROMPT_MAX_CHARS - used)).trim();
  return [item, vocab, tail].filter((s) => s.length > 0).join(" ");
}
