// The words of an HTML fragment, for comparing two renderings of the same
// email: tags out, common entities decoded, whitespace collapsed. Structural
// string handling, not content analysis. Pure.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      const c = code.toLowerCase();
      if (c.startsWith("#x")) return String.fromCodePoint(parseInt(c.slice(2), 16));
      if (c.startsWith("#")) return String.fromCodePoint(parseInt(c.slice(1), 10));
      return ENTITIES[c] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}
