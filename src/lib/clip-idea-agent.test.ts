import { describe, it, expect } from "vitest";
import { alignRangeToCues, type TranscriptSegment } from "./clip-idea-agent";

// Reconstructs the actual transcript shape from the 2026-05-15 Journable
// regression (clip idea 5c9d4c99-…). The LLM picked an app-demo anchor that
// lives at ~1010-1018s; the demo runs ~1004.9-1080s. Content BEFORE 1004.9s
// is the host's setup banter about Android markets, totally unrelated to
// the demo. Content AFTER 1080s is the next podcast topic.
function journableSegments(): TranscriptSegment[] {
  return [
    { startSec: 921.0, endSec: 927.5, text: "Android banter A" },
    { startSec: 927.5, endSec: 933.2, text: "Android banter B" },
    { startSec: 933.2, endSec: 941.3, text: "niche problems setup" },
    { startSec: 941.3, endSec: 946.4, text: "barrier to entry" },
    { startSec: 946.4, endSec: 957.5, text: "niche opportunities" },
    { startSec: 957.5, endSec: 962.7, text: "for anyone thinking…" },
    { startSec: 962.7, endSec: 968.4, text: "day to day apps" },
    { startSec: 968.4, endSec: 974.6, text: "find a niche" },
    { startSec: 974.6, endSec: 980.1, text: "find people who face same problems" },
    { startSec: 980.1, endSec: 981.2, text: "good revenues" },
    { startSec: 981.3, endSec: 986.0, text: "Yeah, super true. lots of things I noticed" },
    { startSec: 986.0, endSec: 990.8, text: "growing markets Android" },
    { startSec: 990.9, endSec: 995.2, text: "localizing to countries" },
    { startSec: 995.3, endSec: 1000.3, text: "worldwide customer base" },
    { startSec: 1000.3, endSec: 1004.9, text: "France South America" },
    { startSec: 1004.9, endSec: 1008.9, text: "I want to see your app" }, // DEMO STARTS
    { startSec: 1008.9, endSec: 1010.5, text: "over a million dollars a year" },
    { startSec: 1010.5, endSec: 1018.1, text: "very simple. type in what you ate" }, // ANCHOR
    { startSec: 1019.0, endSec: 1026.7, text: "yogurt granola blueberries almonds" },
    { startSec: 1026.7, endSec: 1031.4, text: "calorie count, macros split" },
    { startSec: 1031.4, endSec: 1039.3, text: "vinyasa yoga, calories burnt" },
    { startSec: 1039.5, endSec: 1045.2, text: "pictures, select from gallery" },
    { startSec: 1045.2, endSec: 1050.1, text: "transcribe what it sees" },
    { startSec: 1050.1, endSec: 1055.7, text: "identify ingredients" },
    { startSec: 1055.7, endSec: 1061.1, text: "calories and macros per ingredient" },
    { startSec: 1061.1, endSec: 1066.7, text: "weekly view, daily streak" },
    { startSec: 1066.7, endSec: 1071.8, text: "track weight" },
    { startSec: 1071.8, endSec: 1078.6, text: "no complexity, no searching" },
    { startSec: 1078.6, endSec: 1080.8, text: "and the rest is history" }, // DEMO ENDS
    { startSec: 1080.8, endSec: 1086.0, text: "next topic" },
  ];
}

describe("alignRangeToCues", () => {
  it("respects an LLM window that puts the anchor near the start (demo-body anchor)", () => {
    // Reproduces 2026-05-15 Journable bug. LLM picks the natural [1004.9,
    // 1080.8] window for the app-demo clip; anchor "type in what you ate"
    // sits at ~13% from the start because the demo continues for ~60s after.
    // The old hardcoded 0.7 placement target dragged the snapped window
    // backward by ~30s into unrelated Android-markets banter.
    const result = alignRangeToCues({
      intendedStartSec: 1004.9,
      intendedEndSec: 1080.8,
      anchorStartSec: 1010.5,
      anchorEndSec: 1018.1,
      durationSec: 1500,
      segments: journableSegments(),
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // Window must NOT start before 1000s (would mean we're back in Pat's
    // pre-demo Android-markets banter — the original regression).
    expect(result.startSec).toBeGreaterThanOrEqual(1000);
    // Window must extend through most of the demo. Cutting off before 1066s
    // (weekly view / daily streak) means we lose the substantive payoff.
    expect(result.endSec).toBeGreaterThanOrEqual(1066);
  });

  it("caps lead-in even when the LLM wanted a long buildup to a punchline (v8)", () => {
    // Same transcript as above. The LLM proposed a 65s window with 55s
    // of buildup leading to the "very simple, type in what you ate"
    // anchor at the end (~85% of the LLM's window). V7 honored that
    // intent. V8 overrides it: the lead-in cap forces the snap to start
    // within 15s of the anchor, so the anchor lands EARLY in the clip
    // and the payoff explanation plays out after. This is the right
    // tradeoff — the unrelated "Android markets" banter the LLM tried
    // to include is exactly the kind of lead-in v8 strips.
    const result = alignRangeToCues({
      intendedStartSec: 955,
      intendedEndSec: 1020,
      anchorStartSec: 1010.5,
      anchorEndSec: 1018.1,
      durationSec: 1500,
      segments: journableSegments(),
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(1010.5 - result.startSec).toBeLessThanOrEqual(15);
    expect(result.endSec - result.startSec).toBeGreaterThanOrEqual(25);
  });

  it("caps pre-anchor lead-in to ~15s when the LLM intended a long setup (v8)", () => {
    // Reproduces the 2026-05-20 TikTok-strategy bug. The LLM put the
    // payoff "I made three TikTok accounts…" anchor at 327.42s but
    // chose intendedStart=275 (52s of unrelated React/AI/design tangents
    // before the payoff). V7 honored that intent and snapped to 266-357.
    // V8's MAX_LEAD_IN_SEC=15 cap forces the start to be no earlier than
    // anchorStart - 15s, regardless of LLM intent.
    const segments: TranscriptSegment[] = [];
    // Sparse cues throughout the unrelated lead-in.
    for (let t = 260; t <= 330; t += 5) {
      segments.push({ startSec: t, endSec: t + 5, text: `seg @ ${t}` });
    }
    // Post-anchor segments — the payoff explanation continues.
    for (let t = 335; t <= 400; t += 5) {
      segments.push({ startSec: t, endSec: t + 5, text: `seg @ ${t}` });
    }
    const result = alignRangeToCues({
      intendedStartSec: 275,
      intendedEndSec: 355,
      anchorStartSec: 327.42,
      anchorEndSec: 340,
      durationSec: 979,
      segments,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // Lead-in (anchorStart - chosenStart) must be ≤ MAX_LEAD_IN_SEC.
    expect(327.42 - result.startSec).toBeLessThanOrEqual(15);
    // And the window must still be at least the minimum-duration length.
    expect(result.endSec - result.startSec).toBeGreaterThanOrEqual(25);
  });

  it("falls back past the lead-in cap when no near-anchor cue exists", () => {
    // If the only segment boundary before the anchor is way back (e.g.,
    // long monologue), the cap silently relaxes so we still produce a
    // clip rather than failing the entire idea.
    const result = alignRangeToCues({
      intendedStartSec: 950,
      intendedEndSec: 1080,
      anchorStartSec: 1010.5,
      anchorEndSec: 1018.1,
      durationSec: 1500,
      segments: [
        // Only segment start before the anchor is 921 — 89s back, way
        // beyond the 15s cap. Fallback must kick in.
        { startSec: 921, endSec: 1010, text: "long monologue" },
        { startSec: 1010, endSec: 1019, text: "anchor inside here" },
        { startSec: 1019, endSec: 1080, text: "tail" },
      ],
    });
    expect("error" in result).toBe(false);
  });

  it("returns an error when no cue-aligned window can contain the anchor", () => {
    // Tiny segment list with no boundaries that satisfy the 25-95s duration
    // constraint while bracketing the anchor — exercises the error branch
    // so downstream fallback logic in resolveAnchors stays exercised.
    const result = alignRangeToCues({
      intendedStartSec: 1000,
      intendedEndSec: 1050,
      anchorStartSec: 1010,
      anchorEndSec: 1015,
      durationSec: 1500,
      segments: [
        { startSec: 1009, endSec: 1010, text: "barely-before" },
        { startSec: 1015, endSec: 1016, text: "barely-after" },
      ],
    });
    expect("error" in result).toBe(true);
  });
});
