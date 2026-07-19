import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import {
  writeFormatHookForSection,
  HOOK_GENERATED_BY,
  HOOK_PROMPT_VERSION,
  type HookGenerateArgs,
} from "./clip-hook-agent";
import type { TranscriptWord, TranscriptSegment } from "./clip-anchor-utils";

// Deterministic wiring tests for the Splice v10 hook writer. These DON'T
// exercise the model's judgment (that's the gated live eval in
// clip-hook-agent.eval.test.ts) — they assert the plumbing the
// "feature stack" bug slipped through:
//   - an ineligible section never turns into a clip idea,
//   - the format's subject rule actually reaches the system prompt,
//   - a malformed eligible response can never produce a half-formed clip.
// The OpenAI client is injected (HookGenerateArgs.client) so each test
// scripts the exact tool call the model "returns".

const ANCHOR = "we use bubble framer ghost and postgres for the whole stack";

function wordsFor(quote: string, startAt: number): TranscriptWord[] {
  return quote.split(" ").map((w, i) => ({
    word: w,
    startSec: startAt + i * 0.4,
    endSec: startAt + i * 0.4 + 0.4,
  }));
}

function segments(): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let t = 100; t < 160; t += 10) {
    segs.push({ startSec: t, endSec: t + 10, text: `seg ${t}` });
  }
  return segs;
}

/** A scripted OpenAI client. Returns `inputs[i]` as the write_format_hook
 *  tool call on the i-th call (clamps to the last entry). Exposes the spy so
 *  tests can assert on the system prompt that was sent. */
function makeClient(inputs: unknown[]): {
  client: OpenAI;
  create: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const create = vi.fn(async () => {
    const input = inputs[Math.min(call, inputs.length - 1)];
    call++;
    return {
      id: "chatcmpl_test",
      usage: { prompt_tokens: 50, completion_tokens: 30 },
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "tool_1",
                type: "function",
                function: {
                  name: "write_format_hook",
                  arguments: JSON.stringify(input),
                },
              },
            ],
          },
        },
      ],
    };
  });
  return {
    client: {
      chat: { completions: { create } },
    } as unknown as OpenAI,
    create,
  };
}

function baseArgs(overrides: Partial<HookGenerateArgs> = {}): HookGenerateArgs {
  return {
    formatName: "Repackage Tech Stack With Hook",
    formatSkillSection:
      "**Eligibility.** Only eligible when the founder names the tools the product is BUILT ON (Bubble, Framer, Postgres). Not a product/app-feature demo.",
    extrasSchema: null,
    referenceHooks: [],
    section: {
      id: "sec-1",
      startSec: 100,
      endSec: 160,
      transcriptAnchorQuote: ANCHOR,
      transcriptAnchorStartSec: 105,
      topic: "Founder names the tech stack",
      summary: "The founder lists the tools the product runs on.",
      themeTags: ["tech_stack"],
      estimatedViewsBaseline: 100_000,
      transcriptExcerpt: `[01:45] ${ANCHOR}`,
    },
    transcriptWords: wordsFor(ANCHOR, 105),
    transcriptSegments: segments(),
    pillarDurationSec: 600,
    ...overrides,
  };
}

const ELIGIBLE_INPUT = {
  eligible: true,
  reason:
    "Founder enumerates Bubble, Framer, Ghost, Postgres — the actual build stack, tool by tool.",
  hook: "He built a $1.7M business on Bubble. Here's the entire tech stack:",
  angle: "The exact tools behind a $1.7M product.",
  rationale:
    "Leads with authority and promises the list. Same reveal frame as the proven tech-stack hook.",
  estimatedViews: 120_000,
  blueprintAnchorHook:
    "He built a $1.7M business on Bubble. Here's the entire tech stack:",
  transcriptAnchorQuote: ANCHOR,
};

describe("writeFormatHookForSection — wiring", () => {
  it("an ineligible section produces no hook (so the service creates no clip idea)", async () => {
    const { client, create } = makeClient([
      {
        eligible: false,
        reason:
          "This is a product/app-feature demo — the founder walks through what the app does, not the tech it's built on.",
      },
    ]);
    const { candidate } = await writeFormatHookForSection(baseArgs({ client }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(candidate.eligible).toBe(false);
    expect(candidate.hook).toBeNull();
    expect(candidate.angle).toBeNull();
    expect(candidate.rationale).toBeNull();
    // Range falls back to the section's untouched bounds.
    expect(candidate.startSec).toBe(100);
    expect(candidate.endSec).toBe(160);
  });

  it("an eligible section plumbs hook/angle/rationale/anchor through with a resolved range", async () => {
    const { client } = makeClient([ELIGIBLE_INPUT]);
    const { candidate } = await writeFormatHookForSection(baseArgs({ client }));

    expect(candidate.eligible).toBe(true);
    expect(candidate.hook).toBe(ELIGIBLE_INPUT.hook);
    expect(candidate.angle).toBe(ELIGIBLE_INPUT.angle);
    expect(candidate.rationale).toBe(ELIGIBLE_INPUT.rationale);
    expect(candidate.transcriptAnchorQuote).toBe(ANCHOR);
    expect(candidate.estimatedViews).toBe(120_000);
    // Anchor resolved against the transcript and the range stays inside the
    // section bounds.
    expect(candidate.transcriptAnchorStartSec).toBeCloseTo(105, 0);
    expect(candidate.startSec).toBeGreaterThanOrEqual(100);
    expect(candidate.endSec).toBeLessThanOrEqual(160);
    expect(candidate.endSec).toBeGreaterThan(candidate.startSec);
  });

  it("sends the format's subject rule AND the strict anti-reframing language in the system prompt", async () => {
    const { client, create } = makeClient([
      { eligible: false, reason: "n/a" },
    ]);
    await writeFormatHookForSection(baseArgs({ client }));

    const systemPrompt = (
      create.mock.calls[0][0] as {
        messages: { role: string; content: string }[];
      }
    ).messages.find((m) => m.role === "system")!.content;
    // The format's own eligibility rule reached the model...
    expect(systemPrompt).toContain("Only eligible when the founder names");
    expect(systemPrompt).toContain("from format Skill"); // not the default fallback block
    // ...and so did the v2 anti-reframing guardrail.
    expect(systemPrompt).toContain("ACTUAL SUBJECT");
    expect(systemPrompt).toMatch(/feature stack/i);
    expect(systemPrompt).toMatch(/do not relabel/i);
  });

  it("falls back to the default block (no subject Skill) but keeps the strict eligibility rule", async () => {
    const { client, create } = makeClient([
      { eligible: false, reason: "n/a" },
    ]);
    await writeFormatHookForSection(
      baseArgs({ client, formatSkillSection: null }),
    );

    const systemPrompt = (
      create.mock.calls[0][0] as {
        messages: { role: string; content: string }[];
      }
    ).messages.find((m) => m.role === "system")!.content;
    expect(systemPrompt).toContain("default Reels-style fallback");
    // The anti-reframing rule lives in the shared base prompt, so even a
    // format with no Clip Idea Generation section still gets it.
    expect(systemPrompt).toContain("ACTUAL SUBJECT");
    expect(systemPrompt).toMatch(/feature stack/i);
  });

  it("never emits a half-formed clip: a malformed eligible response retries, then gives up as ineligible", async () => {
    // eligible:true but missing hook/angle/rationale — invalid both times.
    const malformed = { eligible: true, reason: "looks like a fit" };
    const { client, create } = makeClient([malformed, malformed]);
    const { candidate } = await writeFormatHookForSection(baseArgs({ client }));

    expect(create).toHaveBeenCalledTimes(2); // initial + one corrective retry
    expect(candidate.eligible).toBe(false);
    expect(candidate.hook).toBeNull();
    expect(candidate.reason).toMatch(/agent error/i);
  });

  it("is attributed to the fixed prompt version (hook-v2)", () => {
    expect(HOOK_PROMPT_VERSION).toBe(2);
    expect(HOOK_GENERATED_BY).toMatch(/:hook-v2$/);
  });
});
