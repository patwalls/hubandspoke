// Editing helpers for the newsletter editor's in-place text boxes: toggle
// bold / italic on a selection (the floating toolbar and Cmd+B / Cmd+I), and
// show images as short "[🖼 …]" tokens while typing instead of long URLs.
// Structural string handling of our own Markdown. Pure.

export type InlineMark = "**" | "*";

export interface Edited {
  value: string;
  start: number;
  end: number;
}

/** Wrap the selection in `mark`, or unwrap it when it's already wrapped. Whitespace at the selection's edges stays outside. */
export function toggleInline(value: string, start: number, end: number, mark: InlineMark): Edited {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(value[s])) s++;
  while (e > s && /\s/.test(value[e - 1])) e--;
  if (s === e) return { value, start, end };
  const n = mark.length;
  const before = value.slice(s - n, s);
  const after = value.slice(e, e + n);
  // "*" must not match one half of a bold "**".
  const isMark = (str: string, at: number) => str === mark && (mark === "**" || value[at] !== "*");
  if (isMark(before, s - n - 1) && isMark(after, e + n) && (mark === "**" || value[s - n - 1] !== "*")) {
    return { value: value.slice(0, s - n) + value.slice(s, e) + value.slice(e + n), start: s - n, end: e - n };
  }
  const inner = value.slice(s, e);
  if (inner.length > 2 * n && inner.startsWith(mark) && inner.endsWith(mark) && (mark === "**" || !inner.startsWith("**"))) {
    return { value: value.slice(0, s) + inner.slice(n, -n) + value.slice(e), start: s, end: e - 2 * n };
  }
  return { value: value.slice(0, s) + mark + inner + mark + value.slice(e), start: s + n, end: e + n };
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const TOKEN = /\[🖼 [^\]\n]*\]/g;

/**
 * Images ↔ tokens for one editing session. `tokens` maps each token to the
 * image Markdown it stands for and stays stable while the box is open, so
 * typing never renumbers a token under the cursor.
 */
export function collapseImages(markdown: string, tokens: Map<string, string>): string {
  const byImage = new Map([...tokens].map(([t, img]) => [img, t]));
  return markdown.replace(IMAGE, (img: string, alt: string) => {
    const known = byImage.get(img);
    if (known) return known;
    const base = `[🖼 ${(alt.trim() || "image").replace(/[[\]]/g, "").slice(0, 60)}`;
    let token = `${base}]`;
    for (let i = 2; tokens.has(token); i++) token = `${base} ${i}]`;
    tokens.set(token, img);
    byImage.set(img, token);
    return token;
  });
}

export function expandImages(text: string, tokens: Map<string, string>): string {
  return text.replace(TOKEN, (t) => tokens.get(t) ?? t);
}
