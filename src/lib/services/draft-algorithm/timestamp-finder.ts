// `find_interesting_timestamps` tool implementation. Called from
// draft-agent.ts during the multi-turn agent loop when the main draft
// agent decides it needs real timestamps for a format whose Skill calls
// for them (e.g. "Full Video On X!" formats that open with a 1-line
// hook + bulleted timestamp breakdown — see Pat's screenshot of the
// canonical X tweet shape).
//
// The main agent COULD scan the segmentsMarkdown text in its own
// prompt, but in practice it (a) hallucinates, (b) rounds, or (c) just
// quotes vague ranges. Pulling editorial scouting into a separate
// specialized call grounded in the raw `segments[]` (not just the
// rendered markdown) gives us auditable, post-validated timestamps.
//
// Cost: gpt-4.1 with max_tokens 1024 is cheap per call when invoked. The
// main draft call is ~$0.03, so a draft that triggers the tool is
// modest total. We use the flagship (gpt-4.1) deliberately —
// "what's interesting" is the editorial judgment we're paying for.

import type OpenAI from "openai";
import { openai } from "@/lib/openai";

const MODEL = "gpt-4.1";

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

export interface FoundTimestamp {
  /** Display format like "5:35" — what gets pasted into the tweet. No
   *  leading zero on minutes < 10 (matches the X format conventions
   *  Pat's freelancers ship: "(0:44)" only when the source actually
   *  showed "0:44"; otherwise "5:35"). */
  mmss: string;
  /** Editor's-voice headline for this moment, ~3-10 words. Becomes
   *  the bulleted line in the tweet (e.g. "How he found this boring
   *  niche"). */
  label: string;
  /** One-sentence justification — why this beat is listenable as a
   *  standalone moment. Surfaced to the main agent as context; rarely
   *  shown to the editor directly. */
  reason: string;
  /** Resolved start time in seconds, useful for downstream
   *  cross-checks against the segments array. */
  startSec: number;
}

export interface FindTimestampsArgs {
  segments: ReadonlyArray<TranscriptSegment>;
  /** The format Skill text — gives the sub-agent context on what kind
   *  of post the timestamps will live in. Optional; sub-agent works
   *  fine without it but quality is better with the format's tone
   *  reference in scope. */
  formatInstructions: string | null;
  /** What the main agent asked for: free-text editorial focus like
   *  "most interesting business breakdown moments" or "moments about
   *  pricing strategy". */
  focus: string;
  /** How many timestamps to return. Clamped 1..10. */
  count: number;
  /** Optional OpenAI client override (testing). Defaults to the shared
   *  `openai()` client which reads the standard env var. */
  client?: OpenAI;
}

const MMSS_RE = /^(\d{1,3}):(\d{2})$/;

function mmssToSec(mmss: string): number | null {
  const m = MMSS_RE.exec(mmss.trim());
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (seconds >= 60) return null;
  return minutes * 60 + seconds;
}

function formatMmss(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SYSTEM_PROMPT = `You are an editorial scout for a content team that turns long-form interviews into short-form social posts.

Your only job: find the N most interesting timestamps in a pillar video's transcript that match the editor's focus.

RULES
- Only return timestamps that correspond to a real segment in the provided transcript. Do NOT interpolate, round, or pick a "neighborhood" — pick the start of the actual segment where the moment begins.
- Pick distinct beats. Two timestamps within ~30 seconds of each other are usually the same moment from a viewer's perspective; spread your picks across the video.
- A "moment" is something a viewer would scrub to and watch as a self-contained beat: a punchline, a surprising number, a strategy reveal, a story turn. Avoid filler ("So…", "Yeah, totally").
- The label should sound like the editor wrote it — not generic ("Discussion of pricing") but specific ("How he priced his beta at $25/mo").
- The reason explains in one sentence why a viewer would scrub there.

OUTPUT
Call return_timestamps exactly once with the array. Never respond with plain text.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "return_timestamps",
      description:
        "Return the curated list of interesting timestamps with editor-voice labels.",
      parameters: {
        type: "object" as const,
        properties: {
          timestamps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                mmss: {
                  type: "string",
                  description:
                    "MM:SS or M:SS format. Must correspond to the start of a real segment in the transcript.",
                },
                label: {
                  type: "string",
                  description:
                    "Editor-voice headline for this moment, 3–10 words.",
                },
                reason: {
                  type: "string",
                  description:
                    "One sentence on why a viewer would scrub here.",
                },
              },
              required: ["mmss", "label", "reason"],
            },
          },
        },
        required: ["timestamps"],
      },
    },
  },
];

function renderSegmentsForPrompt(
  segments: ReadonlyArray<TranscriptSegment>,
): string {
  return segments
    .map((s) => {
      const ts = formatMmss(s.startSec);
      const speakerPrefix = s.speaker ? `${s.speaker}: ` : "";
      return `[${ts}] ${speakerPrefix}${s.text}`;
    })
    .join("\n");
}

/**
 * Run the editorial-scout sub-agent. Returns up to `count` validated
 * timestamps. Invalid picks (mmss that doesn't parse OR doesn't match
 * a real segment within ±2s) are dropped with a console.warn — the
 * caller never sees fabricated timestamps.
 */
export async function findInterestingTimestamps(
  args: FindTimestampsArgs,
): Promise<FoundTimestamp[]> {
  const count = Math.max(1, Math.min(10, args.count));
  const client = args.client ?? openai();

  const userBlocks: string[] = [];
  userBlocks.push(
    `Editor's focus: ${args.focus}\nReturn exactly ${count} timestamps.`,
  );
  if (args.formatInstructions && args.formatInstructions.trim().length > 0) {
    userBlocks.push(
      `## FORMAT SKILL (the editorial brief this draft will fill)\n${args.formatInstructions.trim()}`,
    );
  }
  userBlocks.push(
    `## TRANSCRIPT\nSegments are pre-sliced. Each line: [MM:SS] speaker?: text.\n\n${renderSegmentsForPrompt(args.segments)}`,
  );

  const response: OpenAI.Chat.Completions.ChatCompletion =
    await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "return_timestamps" } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userBlocks.join("\n\n") },
      ],
    });

  let raw: unknown = null;
  for (const call of response.choices[0]?.message?.tool_calls ?? []) {
    if (call.type !== "function" || call.function.name !== "return_timestamps") {
      continue;
    }
    try {
      raw = JSON.parse(call.function.arguments);
    } catch {
      raw = null;
    }
    break;
  }
  if (!raw || typeof raw !== "object") {
    console.warn("timestamp-finder: model returned no tool call");
    return [];
  }
  const picks = (raw as { timestamps?: unknown }).timestamps;
  if (!Array.isArray(picks)) {
    console.warn("timestamp-finder: tool input had no timestamps array");
    return [];
  }

  // Build a sorted index of segment start times for ±2s tolerance match.
  const segStarts = args.segments
    .map((s) => s.startSec)
    .sort((a, b) => a - b);
  const within2s = (sec: number) =>
    segStarts.some((start) => Math.abs(start - sec) <= 2);

  const validated: FoundTimestamp[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const pick of picks) {
    if (!pick || typeof pick !== "object") continue;
    const rec = pick as Record<string, unknown>;
    const mmss = typeof rec.mmss === "string" ? rec.mmss.trim() : "";
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    if (!mmss || !label) {
      dropped++;
      continue;
    }
    const sec = mmssToSec(mmss);
    if (sec === null) {
      console.warn(`timestamp-finder: dropped malformed mmss "${mmss}"`);
      dropped++;
      continue;
    }
    if (!within2s(sec)) {
      console.warn(
        `timestamp-finder: dropped out-of-range mmss "${mmss}" (no segment within ±2s of ${sec}s)`,
      );
      dropped++;
      continue;
    }
    if (seen.has(mmss)) {
      dropped++;
      continue;
    }
    seen.add(mmss);
    validated.push({ mmss, label, reason, startSec: sec });
  }

  const final = validated.slice(0, count);
  // v1.6: single summary log so the main agent loop's observation of
  // "validated vs requested" is grepable in one line.
  console.info(
    `timestamp-finder: focus="${args.focus.slice(0, 80)}" requested=${count} validated=${final.length}${dropped > 0 ? ` (dropped ${dropped})` : ""}`,
  );

  return final;
}
