/**
 * Does a format's Skill post a clip CUT from the source video? One of the two
 * signals that send a format's posts on X to the in-app clip editor
 * (`formatsForClipPosts` in from-candidate.ts); the other is the format's
 * published video history. Either one is enough — the Skill lets a brand-new
 * format work from its first post, the history catches a Skill that never
 * says so. A Skill that posts the WHOLE video always stays in the classic
 * view (a full-length re-encode would hold the serial media-heavy queue).
 *
 * Read by Haiku because "clip out the intro" vs "post the full episode" vs
 * "write a thread about it" is a question of meaning, not wording. The answer
 * is saved on the format (`formats.clip_post_skill_check`) keyed by a hash of
 * the Skill, so the model runs once per Skill edit, not per queue load.
 *
 * Fail-soft like pick-post-clip.ts: an LLM failure returns null (nothing is
 * saved, so the next load asks again) and the history signal still applies.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, type ClipPostSkillCheck } from "@/lib/db/schema";

const MODEL = "claude-haiku-5-5";
/** Bump to re-read every Skill (the version is part of the hash). */
const CHECK_VERSION = "skill-clip-check:v1";

export function skillHash(skill: string | null): string {
  return createHash("sha256").update(`${CHECK_VERSION}\n${(skill ?? "").trim()}`).digest("hex").slice(0, 32);
}

const SYSTEM_PROMPT = `You read the instructions (the "Skill") a team wrote for one social post format, and say what video the post carries.

Answer with one of:
- clip: the post's video is a PART cut from a longer source video — an intro, a highlight, a specific section, a moment, a short clip.
- whole_video: the post's video is the ENTIRE source video, uploaded as-is (e.g. "full video", "post the whole episode").
- none: the post carries no video from the source (text only, a thread, a quote, an image, a carousel, a screenshot), or the Skill doesn't say.

Judge what the Skill asks for, not the format's name. reason: one short plain sentence a teammate would understand, e.g. "The Skill cuts the intro from the video."

Never respond with plain text. Always call return_verdict exactly once.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "return_verdict",
    description: "What video this format's posts carry.",
    input_schema: {
      type: "object" as const,
      properties: {
        verdict: { type: "string", enum: ["clip", "whole_video", "none"] },
        reason: { type: "string", description: "One short plain sentence." },
      },
      required: ["verdict", "reason"],
    },
  },
];

/** Ask the model. Null when it can't answer (no call is made for an empty
 *  Skill — that is a plain "none"). Exported for the test. */
export async function classifySkill(args: {
  formatName: string;
  skill: string | null;
  client?: Anthropic;
}): Promise<Omit<ClipPostSkillCheck, "checkedAt" | "skillHash"> | null> {
  const skill = args.skill?.trim();
  if (!skill) return { verdict: "none", reason: "The format has no Skill written yet." };
  let response: Anthropic.Message;
  try {
    const client = args.client ?? new Anthropic();
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "return_verdict" },
      messages: [{ role: "user", content: `FORMAT: ${args.formatName}\n\nSKILL:\n${skill}` }],
    });
  } catch (err) {
    console.error("[skill-clip-check] LLM call failed:", err);
    return null;
  }
  const block = response.content.find((b) => b.type === "tool_use" && b.name === "return_verdict");
  if (!block || block.type !== "tool_use") return null;
  const input = block.input as { verdict?: unknown; reason?: unknown };
  if (input.verdict !== "clip" && input.verdict !== "whole_video" && input.verdict !== "none") return null;
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "";
  return { verdict: input.verdict, reason };
}

/**
 * The saved verdict for each format, read again (and saved) for any whose
 * Skill changed since. Formats whose model call fails are absent from the
 * map. Calls run in parallel; a brand has a handful of X formats.
 */
export async function skillChecksFor(
  rows: { id: string; name: string; instructions: string | null; clipPostSkillCheck: ClipPostSkillCheck | null }[],
  opts: { classify?: typeof classifySkill } = {},
): Promise<Map<string, ClipPostSkillCheck>> {
  const out = new Map<string, ClipPostSkillCheck>();
  await Promise.all(
    rows.map(async (row) => {
      const hash = skillHash(row.instructions);
      if (row.clipPostSkillCheck?.skillHash === hash) {
        out.set(row.id, row.clipPostSkillCheck);
        return;
      }
      const read = await (opts.classify ?? classifySkill)({ formatName: row.name, skill: row.instructions });
      if (!read) return;
      const check: ClipPostSkillCheck = { ...read, skillHash: hash, checkedAt: new Date().toISOString() };
      try {
        await db.update(formats).set({ clipPostSkillCheck: check }).where(eq(formats.id, row.id));
      } catch (err) {
        console.error("[skill-clip-check] save failed:", err);
      }
      out.set(row.id, check);
    }),
  );
  return out;
}
