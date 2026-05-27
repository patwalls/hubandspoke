import { describe, it, expect } from "vitest";
import {
  writeFormatHookForSection,
  type HookGenerateArgs,
} from "./clip-hook-agent";
import type { TranscriptWord, TranscriptSegment } from "./clip-anchor-utils";

// GATED LIVE EVAL — calls the real Haiku hook writer to prove it makes the
// right ELIGIBILITY call. This is the test that actually catches the
// "feature stack" regression (an app-feature demo accepted for the Tech
// Stack format). It is excluded from `npm run test`; run it with:
//
//   npm run test:eval        (sets RUN_LLM_EVALS=1; needs ANTHROPIC_API_KEY)
//
// When iterating on the eligibility prompt in clip-hook-agent.ts, run this
// until every fixture's expectedEligible passes.
const RUN = !!process.env.RUN_LLM_EVALS;

// Mirrors the `## Clip Idea Generation` section authored on the
// "Repackage Tech Stack With Hook" format (src/lib/format-skill.ts is the
// extractor). Inlined here so the eval is hermetic — it validates the
// prompt+skill design, not whatever happens to be in the dev DB.
const TECH_STACK_SKILL = `**Eligibility — this is the whole point of the format.** Only eligible when the founder names the actual tech they BUILD ON or RUN ON: the framework, language, no-code builder (e.g. Bubble), hosting/infra, database, AI APIs, and the core SaaS in their build-and-ops workflow (e.g. "Bubble for the app, Framer for the site, Ghost for content, Ahrefs for SEO"). The clip should be the founder enumerating their stack — tool by tool.

NOT eligible — return eligible:false for any of these, even when the section mentions software or "an app":
- A product/app-feature DEMO: the founder walking through what their app does for its users ("open the calculator, log a dose, pick an injection site, view the weekly streak"). That is a feature tour, not a tech stack. Do NOT relabel it a "feature stack" to make it fit.
- Generic "I built an app" / "I'm technical" mentions with no tools named.
- Revenue, pricing, or business-model talk.
- Growth, marketing, or distribution tactics.

If you are unsure whether a tool the founder names is part of their build stack versus just a feature of their product, lean eligible:false.

**Hook style.** A list-tease reveal mirroring: "He built a $1.7M business on Bubble. Here's the entire tech stack:".

**Target runtime.** 30-60s.`;

const REFERENCE_HOOKS = [
  {
    hook: "He built a $1.7M business on Bubble. Here's the entire tech stack:",
    views: 108_000,
  },
  { hook: "The exact stack behind a $40k/mo micro-SaaS:", views: 64_000 },
];

/** Build word-level + segment transcript from an excerpt so any verbatim
 *  ≥8-word quote the model copies out resolves against the words array. One
 *  segment per sentence; words laid sequentially from `baseSec`. */
function transcriptFromExcerpt(
  excerpt: string,
  baseSec: number,
): { words: TranscriptWord[]; segments: TranscriptSegment[] } {
  const sentences = excerpt
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const words: TranscriptWord[] = [];
  const segments: TranscriptSegment[] = [];
  let t = baseSec;
  const STEP = 0.4;
  for (const sentence of sentences) {
    const segStart = t;
    for (const w of sentence.split(/\s+/)) {
      words.push({ word: w, startSec: t, endSec: t + STEP });
      t += STEP;
    }
    segments.push({ startSec: segStart, endSec: t, text: sentence });
    t += 0.2; // small inter-sentence gap so cue boundaries are distinct
  }
  return { words, segments };
}

interface Fixture {
  name: string;
  expectedEligible: boolean;
  topic: string;
  summary: string;
  themeTags: string[];
  excerpt: string;
  startSec: number;
}

const FIXTURES: Fixture[] = [
  {
    // The reported regression: founder demos his peptide-dosing app's
    // user-facing features. NOT a tech stack.
    name: "app-feature demo (peptide dosing app)",
    expectedEligible: false,
    topic: "Walkthrough of the peptide dosing app's calculator and dose logger",
    summary:
      "The founder demos the app: enter the vial amount and water, it computes how many units to pull, then log a dose and pick an injection site.",
    themeTags: ["demo_walkthrough"],
    excerpt:
      "So the first feature I would use is the calculator where you put in your vial amount. Then you add your water and how much you're wanting to take. And from there it tells you how many units to pull to. After that you can log a dose. And from the calculator you know how much you would be taking and then choose your injection site, which is really important because you want to remember where you did it last time.",
    startSec: 743,
  },
  {
    // The genuine article: founder enumerates the tools the product runs on.
    name: "real tech stack (Bubble/Framer/Ghost/Ahrefs)",
    expectedEligible: true,
    topic: "Full tech stack of a $1.7M/year business — built on Bubble",
    summary:
      "The founder names the tools the business runs on, tool by tool: the app builder, the marketing site, content publishing, and SEO.",
    themeTags: ["tech_stack", "tactical_advice"],
    excerpt:
      "People always ask what we use to build this. We use Bubble. Our entire product is built on it. Framer powers our marketing website. Ghost handles all of our content publishing. We run a lot of operations tasks through ChatGPT Plus. And we use Ahrefs for all of our SEO work.",
    startSec: 758,
  },
  {
    // Revenue talk — adjacent founder content, wrong subject for this format.
    name: "revenue reveal (no tools named)",
    expectedEligible: false,
    topic: "Founder reveals $1.7M annual revenue from a boring niche",
    summary:
      "The founder explains how the business reached $1.7M a year in a niche most people overlook, and why the margins are strong.",
    themeTags: ["revenue_reveal"],
    excerpt:
      "Last year we did just over one point seven million dollars in revenue. And the wild part is it's a totally boring niche nobody wants to touch. The margins are incredible because there's basically no competition fighting over it.",
    startSec: 900,
  },
];

describe.skipIf(!RUN)("writeFormatHookForSection — live eligibility eval", () => {
  for (const fx of FIXTURES) {
    it(`${fx.expectedEligible ? "ACCEPTS" : "REJECTS"}: ${fx.name}`, async () => {
      const { words, segments } = transcriptFromExcerpt(fx.excerpt, fx.startSec);
      const endSec = segments[segments.length - 1].endSec;
      const args: HookGenerateArgs = {
        formatName: "Repackage Tech Stack With Hook",
        formatSkillSection: TECH_STACK_SKILL,
        extrasSchema: null,
        referenceHooks: REFERENCE_HOOKS,
        section: {
          id: `eval-${fx.startSec}`,
          startSec: fx.startSec,
          endSec,
          transcriptAnchorQuote: "", // unused — the writer picks its own
          transcriptAnchorStartSec: fx.startSec,
          topic: fx.topic,
          summary: fx.summary,
          themeTags: fx.themeTags,
          estimatedViewsBaseline: 100_000,
          transcriptExcerpt: segments
            .map((s) => `[12:${String(Math.round(s.startSec) % 60).padStart(2, "0")}] ${s.text}`)
            .join("\n"),
        },
        transcriptWords: words,
        transcriptSegments: segments,
        pillarDurationSec: 1800,
      };

      const { candidate } = await writeFormatHookForSection(args);
      // Surface the model's own reason on failure — makes prompt iteration
      // fast (you see WHY it judged wrong, not just that it did).
      expect(
        candidate.eligible,
        `model reason: ${candidate.reason}`,
      ).toBe(fx.expectedEligible);
    });
  }
});
