// How a Futurepedia (beehiiv-style) section's Markdown is LAID OUT before it
// is rendered: numbered steps with the title on its own bold line, bullets as
// the section's `bullets` setting says (the ✅ block as tight lines, use cases
// and tips as paragraphs), the arrow after a link, the "- Kevin" sign-off kept
// a line. Structural handling of the drafter's own constrained Markdown, not
// content analysis. The email renderer (newsletter-email-html.ts) runs this
// for every beehiiv template, so the canvas, the preview and the push (one
// html block since 2026-10-26; native blocks before) all agree. Pure.

/**
 * Numbered steps as the Kevin/Saj templates lay them out: the step's title on
 * its own bold line, its explanation in the paragraph(s) below. A step written
 * with an inline lead-in — "**4. Copy the prompt.** Click…" or
 * "4. **Copy the prompt.** Click…" — is split into "**4. Copy the prompt**"
 * and "Click…" (the title's trailing period/colon dropped, as in the
 * template). Structural handling of our own Markdown. Pure; exported for tests.
 */
export function splitStepTitles(md: string): string {
  return md
    .split("\n")
    .flatMap((line) => {
      const m = line.match(/^\s*(?:\*\*(\d+)\.\s+([^*]+?)\*\*|(\d+)\.\s+\*\*([^*]+?)\*\*)\s+(\S.*)$/);
      if (!m) return [line];
      const n = m[1] ?? m[3];
      const title = (m[2] ?? m[4]).trim().replace(/[.:]$/, "");
      return [`**${n}. ${title}**`, m[5]];
    })
    .join("\n");
}

/** "- Kevin" / "- Saj" on its own line: the intro's sign-off, not a one-item list. */
const SIGNOFF = /^-\s+(Saj|Kevin)$/;

/** Markdown with the sign-off escaped ("\\- Kevin") so a Markdown renderer keeps it a line. Pure. */
export function keepSignoff(md: string): string {
  return md.replace(new RegExp(SIGNOFF.source, "gm"), "\\- $1");
}

/**
 * A section's bullets laid out as its template's `bullets` setting says (see
 * sectionSchema): "lines" joins a run of bullets (or ✅-led lines) into one
 * paragraph with a line break between items (Markdown hard breaks, "  \n");
 * "paragraphs" makes each bullet its own paragraph. "- Kevin" / "- Saj" stay
 * the sign-off. Pure; exported for tests.
 */
export function flattenBullets(md: string, mode: "list" | "lines" | "paragraphs"): string {
  if (mode === "list") return md;
  const out: string[] = [];
  let group: string[] = [];
  const flush = () => {
    if (!group.length) return;
    out.push("", group.join(mode === "lines" ? "  \n" : "\n\n"), "");
    group = [];
  };
  for (const line of md.split("\n")) {
    const bullet = /^\s*-\s+(Saj|Kevin)\s*$/.test(line) ? null : line.match(/^\s*[-*•]\s+(.*)$/);
    const item = bullet ? bullet[1].trim() : mode === "lines" && /^\s*✅/.test(line) ? line.trim() : null;
    if (item) {
      group.push(item);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "[label →](url)" or "[label](url) ->" → "[label](url) →": the Kevin/Saj arrow sits after the link. Pure. */
export function arrowAfterLink(md: string): string {
  return md.replace(/\[([^\]]*?)\s*(?:->|→)\s*\]\(([^)\s]+)\)(?:\s*(?:->|→))?/g, "[$1]($2) →").replace(/\]\(([^)\s]+)\)\s*->/g, "]($1) →");
}

/** A section's Markdown laid out as the template does it (canvas, preview and push share this). Pure. */
export function layoutSection(md: string, bullets: "list" | "lines" | "paragraphs" = "list"): string {
  return arrowAfterLink(flattenBullets(splitStepTitles(md), bullets));
}
