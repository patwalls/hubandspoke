/**
 * Which part of a pillar a video post on X carries — "the intro and only
 * the intro" for Share The BIG IDEA, a stretch the Skill describes for
 * another format. Read by Haiku from the format's Skill and the pillar's
 * timed transcript, because where an intro ends is a question about what is
 * being said, not about timestamps.
 *
 * Answers in transcript LINE numbers (not seconds), so the clip always
 * starts and ends on a line boundary the editor can show. A format whose
 * Skill posts the whole pillar says so (`wholeVideo`) — those don't belong
 * in the clip editor (a full-length re-encode would hold the serial
 * media-heavy queue for many minutes).
 *
 * Fail-soft like derivative-hook.ts: an LLM failure falls back to the
 * opening ~minute (`fallbackIntroRange`), never throws.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
export const POST_CLIP_PICKER_VERSION = `${MODEL}:post-clip:v1`;

/** The transcript Haiku sees. Intros and most "a section of the video"
 *  formats live early; this is ~15–20 minutes of speech. */
const TRANSCRIPT_CHAR_BUDGET = 20_000;

/** Fallback intro: end on the first line boundary past this… */
const FALLBACK_MIN_SEC = 40;
/** …but never run longer than this. */
const FALLBACK_MAX_SEC = 90;

export interface PostClipSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface PostClipPick {
  startSec: number;
  endSec: number;
  /** One line on what the clip is — becomes the clip idea's hook and the
   *  item's title. Never burned in by default (the layout hides the hook). */
  hook: string;
  angle: string;
  rationale: string;
  source: "llm" | "fallback";
}

export type PickPostClipResult =
  | { kind: "clip"; pick: PostClipPick }
  /** The Skill posts the entire pillar — not a clip. */
  | { kind: "whole_video"; rationale: string };

function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The opening ~minute, cut at a line boundary. Structural, not semantic —
 *  only used when the model can't answer. */
export function fallbackIntroRange(segments: PostClipSegment[]): { startSec: number; endSec: number } | null {
  if (segments.length === 0) return null;
  const startSec = segments[0].startSec;
  let endSec = segments[0].endSec;
  for (const s of segments) {
    if (s.endSec - startSec > FALLBACK_MAX_SEC) break;
    endSec = s.endSec;
    if (endSec - startSec >= FALLBACK_MIN_SEC) break;
  }
  return { startSec, endSec };
}

/** The numbered lines the model reads, within the budget. Exported for the
 *  test. */
export function numberedTranscript(segments: PostClipSegment[], budget = TRANSCRIPT_CHAR_BUDGET): { text: string; count: number } {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < segments.length; i++) {
    const line = `[${i}] ${mmss(segments[i].startSec)} ${segments[i].text.trim()}`;
    if (used + line.length > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), count: lines.length };
}

/** Turn the model's line numbers into a source range, or null when they
 *  don't describe one. Exported for the test. */
export function rangeFromLines(segments: PostClipSegment[], visible: number, first: unknown, last: unknown): { startSec: number; endSec: number } | null {
  if (!Number.isInteger(first) || !Number.isInteger(last)) return null;
  const a = first as number;
  const b = last as number;
  if (a < 0 || b < a || b >= visible) return null;
  const startSec = segments[a].startSec;
  const endSec = segments[b].endSec;
  return endSec > startSec ? { startSec, endSec } : null;
}

const SYSTEM_PROMPT = `You pick the part of a long YouTube video that goes out as the VIDEO in a post on X (Twitter).

You get the post format's instructions (its "Skill", written by the team for a human editor) and the video's transcript as numbered lines with timestamps. Find the stretch of the video the Skill says to use and answer with the first and last line numbers of it.

RULES
- Follow the Skill. "Clip out the intro and only the intro" means the cold open: from the first line up to the line where the intro hands off to the main video (a title/channel moment, "let's get into it", the first interview question, the start of the first chapter). Not the whole first section.
- If the Skill posts the ENTIRE video (e.g. "full video", upload the whole episode), set whole_video to true; the line numbers are then ignored.
- If the Skill doesn't say which part, pick the strongest self-contained 30–90 seconds that sells the whole video — usually the opening.
- Start on a line that begins a thought and end on a line that finishes one.
- hook: one plain sentence saying what the clip is about, grounded in a specific (a number, a product, an outcome). Not a caption, no hashtags, no emoji.

Never respond with plain text. Always call return_clip exactly once.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "return_clip",
    description: "Return the stretch of the video this post uses.",
    input_schema: {
      type: "object" as const,
      properties: {
        whole_video: { type: "boolean", description: "True only when the Skill posts the entire video." },
        first_line: { type: "integer", description: "Line number the clip starts on (inclusive)." },
        last_line: { type: "integer", description: "Line number the clip ends on (inclusive)." },
        hook: { type: "string", description: "One plain sentence: what the clip is about, with a specific." },
        rationale: { type: "string", description: "One sentence: why this stretch, in terms of the Skill." },
      },
      required: ["whole_video", "first_line", "last_line", "hook", "rationale"],
    },
  },
];

export async function pickPostClip(args: {
  formatName: string;
  skill: string | null;
  sourceTitle: string | null;
  segments: PostClipSegment[];
  durationSec: number | null;
  client?: Anthropic;
}): Promise<PickPostClipResult | null> {
  const { segments } = args;
  const fallback = fallbackIntroRange(segments);
  if (!fallback) return null;
  const fallbackPick = (why: string): PickPostClipResult => ({
    kind: "clip",
    pick: {
      ...fallback,
      hook: args.sourceTitle?.trim() || "The intro",
      angle: "Intro",
      rationale: why,
      source: "fallback",
    },
  });

  const transcript = numberedTranscript(segments);
  const duration = args.durationSec ?? segments[segments.length - 1].endSec;
  const user = [
    `FORMAT: ${args.formatName}`,
    "",
    "SKILL:",
    args.skill?.trim() || "(none written — use the opening of the video)",
    "",
    `VIDEO: ${args.sourceTitle ?? "(untitled)"} — ${mmss(duration)} long. Transcript lines 0–${transcript.count - 1}${transcript.count < segments.length ? ` (of ${segments.length}; the rest is cut for length)` : ""}:`,
    transcript.text,
  ].join("\n");

  let response: Anthropic.Message;
  try {
    const client = args.client ?? new Anthropic();
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "return_clip" },
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    console.error("[pick-post-clip] LLM call failed:", err);
    return fallbackPick("Opening of the video (the clip picker was unavailable).");
  }
  const block = response.content.find((b) => b.type === "tool_use" && b.name === "return_clip");
  if (!block || block.type !== "tool_use") return fallbackPick("Opening of the video (the clip picker gave no answer).");
  const input = block.input as { whole_video?: unknown; first_line?: unknown; last_line?: unknown; hook?: unknown; rationale?: unknown };
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (input.whole_video === true) return { kind: "whole_video", rationale };
  const range = rangeFromLines(segments, transcript.count, input.first_line, input.last_line);
  if (!range) return fallbackPick("Opening of the video (the clip picker's range was unusable).");
  const hook = typeof input.hook === "string" && input.hook.trim() ? input.hook.trim() : args.sourceTitle?.trim() || "The intro";
  return {
    kind: "clip",
    pick: { ...range, hook, angle: args.formatName, rationale: rationale || `Picked for ${args.formatName}.`, source: "llm" },
  };
}
