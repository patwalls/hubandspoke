/**
 * The canonical structure for a format's prompt ("skill").
 *
 * Each format's `instructions` text is treated like a Claude Skill: a
 * self-contained markdown recipe that the dispatcher agent reads when
 * producing content in that format. The four sections below are the
 * shape the agent looks for. The text is also what ships into Asana
 * tasks, so sections double as human-readable documentation.
 */
export const DEFAULT_FORMAT_SKILL_TEMPLATE = `## What this format is
Short one-liner. e.g. Vertical 30–60s highlight clip for Instagram Reels.

## Why it works
What makes this format hit. e.g. Strong hook in the first 3s, payoff by 15s. Audience gets a tactical insight without watching the full pillar.

## Clip guidance
How to pick and frame the moment. e.g. Look for a single strong quote, a surprising reveal, or a tactical tip. Start on a clean sentence boundary. End on a thought-ending beat. Target length 30–60 seconds.

## Avoid
What not to do. e.g. No filler intros. No "so yeah" tail-offs. Skip moments where the speaker is reading from a doc.
`;

const TEMPLATE_HEADINGS = [
  "## What this format is",
  "## Why it works",
  "## Clip guidance",
  "## Avoid",
];

/**
 * If the existing prompt is empty, replace it with the template.
 * If it's non-empty, append any template headings it's missing, so
 * users can opt in incrementally without losing their existing text.
 */
export function applyStarterTemplate(existing: string): string {
  const trimmed = existing.trim();
  if (!trimmed) return DEFAULT_FORMAT_SKILL_TEMPLATE;
  const missing = TEMPLATE_HEADINGS.filter(
    (h) => !trimmed.toLowerCase().includes(h.toLowerCase())
  );
  if (missing.length === 0) return existing;
  const appended = missing
    .map((h) => {
      const body = DEFAULT_FORMAT_SKILL_TEMPLATE.split(h)[1]?.split("## ")[0] ?? "";
      return `${h}\n${body.trim()}\n`;
    })
    .join("\n");
  return `${existing.trimEnd()}\n\n${appended}`;
}
