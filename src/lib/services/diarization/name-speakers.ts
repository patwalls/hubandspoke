/**
 * Put names to detected speakers ("S1" → "Pat Walls", host).
 *
 * An LLM, because the evidence is free-form content: a title ("How I Built
 * This $160K/Month App"), a channel, and what people actually say ("Hey, I'm
 * Jay", "welcome back to the show", "so Ken, how did you…"). Shape mirrors
 * services/draft-algorithm/derivative-hook.ts — Haiku, one pinned tool,
 * fail-soft `{ ok: false, failure }`.
 *
 * Conservative by design: a name is only APPLIED when the model says it is
 * highly confident. A wrong name is worse than "Speaker 2" — it gets pasted
 * into prompts and captions as if it were fact. Roles are lower-stakes and
 * are kept at any confidence.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SpeakerRole } from "@/lib/diarization/types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_SAMPLE_CHARS = 220;
const SAMPLES_PER_SPEAKER = 6;
const OPENING_CHARS = 2500;

export interface SpeakerEvidence {
  id: string;
  talkSharePct: number;
  /** Things this speaker said, in order, earliest first. */
  samples: string[];
}

export interface NameSpeakersInput {
  title: string | null;
  description: string | null;
  /** The channel/account that published it, and its owner if known. */
  channelName: string | null;
  authorName: string | null;
  speakers: SpeakerEvidence[];
  /** The start of the recording with speaker ids inline — introductions
   *  happen here. */
  opening: string;
  client?: Anthropic;
}

export interface SpeakerNaming {
  id: string;
  name: string | null;
  role: SpeakerRole;
}

export type NameSpeakersResult =
  | { ok: true; speakers: SpeakerNaming[] }
  | { ok: false; failure: { reason: "llm-error" | "llm-no-tool-call"; message?: string } };

const SYSTEM_PROMPT = `You identify who is speaking in a transcribed recording.

Speakers have already been separated by voice and given ids (S1, S2, …). Using the recording's title, channel, and what each speaker says, work out each speaker's real NAME and ROLE.

Evidence that counts: self-introductions ("I'm Jay"), being addressed by name ("so Ken, tell me…" — the name belongs to the OTHER speaker), the title or description naming the guest, the channel owner being the host or narrator. A narrator is a voice that describes the subject in the third person ("This is Ken. He spent his career…") rather than conversing.

Rules:
- Only give a name you can tie to a specific speaker id from the evidence. If the title names a guest but you can't tell which voice is theirs, leave both names null.
- Never invent or guess a name. "unknown" and null are correct answers.
- confidence "high" means the evidence is explicit (introduced themselves, or were addressed by name, or are unmistakably the titled subject speaking in first person about it). Anything inferred from style alone is "low".

Never respond with plain text. Always call name_speakers exactly once, with one entry per speaker id you were given.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "name_speakers",
    description: "Report the name and role of each detected speaker.",
    input_schema: {
      type: "object" as const,
      properties: {
        speakers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The speaker id exactly as given, e.g. S1." },
              name: {
                type: ["string", "null"],
                description: "Full name if known from the evidence, else null.",
              },
              role: { type: "string", enum: ["host", "guest", "narrator", "unknown"] },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              evidence: {
                type: "string",
                description: "One short sentence: what in the inputs supports this.",
              },
            },
            required: ["id", "name", "role", "confidence", "evidence"],
          },
        },
      },
      required: ["speakers"],
    },
  },
];

const ROLES: SpeakerRole[] = ["host", "guest", "narrator", "unknown"];

export function buildNamingEvidence(input: NameSpeakersInput): string {
  const lines: string[] = [
    `## RECORDING`,
    `Title: ${input.title ?? "(untitled)"}`,
    `Channel: ${input.channelName ?? "(unknown)"}${input.authorName ? ` — run by ${input.authorName}` : ""}`,
  ];
  if (input.description) {
    lines.push(`Description: ${input.description.replace(/\s+/g, " ").trim().slice(0, 400)}`);
  }
  lines.push("", "## SPEAKERS");
  for (const s of input.speakers) {
    lines.push(`### ${s.id} — ${s.talkSharePct}% of the talking`);
    for (const sample of s.samples.slice(0, SAMPLES_PER_SPEAKER)) {
      lines.push(`- "${sample.slice(0, MAX_SAMPLE_CHARS)}"`);
    }
  }
  lines.push("", "## OPENING OF THE RECORDING", input.opening.slice(0, OPENING_CHARS));
  lines.push("", "Call name_speakers now.");
  return lines.join("\n");
}

export async function nameSpeakers(input: NameSpeakersInput): Promise<NameSpeakersResult> {
  const client = input.client ?? new Anthropic();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "name_speakers" },
      messages: [{ role: "user", content: buildNamingEvidence(input) }],
    });
  } catch (err) {
    return {
      ok: false,
      failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) },
    };
  }

  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "name_speakers") continue;
    const raw = (block.input as { speakers?: unknown }).speakers;
    const known = new Set(input.speakers.map((s) => s.id));
    const out = new Map<string, SpeakerNaming>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      const e = entry as { id?: unknown; name?: unknown; role?: unknown; confidence?: unknown };
      if (typeof e.id !== "string" || !known.has(e.id) || out.has(e.id)) continue;
      const role = ROLES.includes(e.role as SpeakerRole) ? (e.role as SpeakerRole) : "unknown";
      const name =
        e.confidence === "high" && typeof e.name === "string" && e.name.trim().length > 0
          ? e.name.trim().slice(0, 80)
          : null;
      out.set(e.id, { id: e.id, name, role });
    }
    // Two voices can't both be the same person — if the model says so, it
    // doesn't actually know which one is; trust neither.
    const seen = new Map<string, string[]>();
    for (const s of out.values()) {
      if (!s.name) continue;
      const key = s.name.toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), s.id]);
    }
    for (const ids of seen.values()) {
      if (ids.length > 1) for (const id of ids) out.get(id)!.name = null;
    }
    return { ok: true, speakers: [...out.values()] };
  }
  return { ok: false, failure: { reason: "llm-no-tool-call" } };
}
