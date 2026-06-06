// Representative CTA exemplars — the "training data" for the smart CTA
// generator. These are REAL published Starter Story CTAs (transcribed from
// Pat's posts, 2026-06-06), not invented. They encode the house style:
//
//   <one casual, first-person line that ends with a colon>
//   <link>
//
// The generator writes only the FIRST line (the `copyLine`, ending in a colon);
// the tracked go.starterstory.com link is appended programmatically. So these
// teach two things: (1) Pat's voice for that one-liner, and (2) when to point
// at a guest's episode vs. a lead magnet.
//
// Voice notes drawn from the real corpus:
//   - Casual & first-person ("i made", "I created this list", "Forgot to say, but…").
//   - Often opens with a throwaway connector: "Btw,", "oh and btw", "Forgot to say, but".
//   - ALWAYS ties back to what the post was about ("like this one", "solo devs
//     doing cool stuff like this", "the whole episode with Brian").
//   - Episode CTAs name the guest ("watch the whole episode with Brian here:").
//   - No hashtags, no emoji. Always ends with a colon.
//
// Pat: edit/expand freely as you collect more. Keep `copyLine` a single line
// ending in a colon.

export type CtaChannel = "x" | "linkedin" | "ytcommunity" | "threads";
export type CtaExemplarTarget = "lead_magnet" | "episode";

export interface CtaExemplar {
  channel: CtaChannel;
  /** What the post was about — context so the model learns target selection. */
  postAbout: string;
  /** The one-liner the model should emulate. MUST end with a colon. */
  copyLine: string;
  /** What this CTA pointed at, so the model learns episode-vs-leadmagnet choice. */
  target: CtaExemplarTarget;
}

// Real published CTAs (verbatim copy lines).
export const CTA_EXEMPLARS: CtaExemplar[] = [
  // ── Episode-first: post is about a specific guest → link to their episode ──
  {
    channel: "x",
    postAbout:
      "A post built around one guest's story/tactic (e.g. Brian's $20K/mo app + his validation strategy).",
    copyLine:
      "Brian has a very unique validation strategy oh and btw you can watch the whole episode with Brian here:",
    target: "episode",
  },

  // ── Lead-magnet CTAs (the common case) ───────────────────────────────────
  {
    channel: "x",
    postAbout:
      "A guest post (Marc Lou's accidental $35K/mo marketplace) where the CTA pivots to a themed lead magnet instead of the episode.",
    copyLine:
      "And this video is the reason i created this list of problems you can solve check it out below:",
    target: "lead_magnet",
  },
  {
    channel: "x",
    postAbout: "A post about a simple app that makes a lot of money.",
    copyLine:
      "Forgot to say, but I created a database of simple apps like this one that make millions. You can check it out here:",
    target: "lead_magnet",
  },
  {
    channel: "x",
    postAbout: "A build-something-this-weekend angle.",
    copyLine:
      "Get yourself ready to build something on the weekend with this database i made:",
    target: "lead_magnet",
  },
  {
    channel: "linkedin",
    postAbout: "A college founder whose app took off (an app/idea story).",
    copyLine: "Btw, your next app idea could be on this list so check it out:",
    target: "lead_magnet",
  },
  {
    channel: "threads",
    postAbout: "A solo dev with a small high-margin side project (Questgen).",
    copyLine:
      "Every time I find solo devs doing cool stuff like this, I add them to this spreadsheet:",
    target: "lead_magnet",
  },
  {
    channel: "ytcommunity",
    postAbout: "A deep-work / founder-routine observation post.",
    copyLine: "The power of deep work:",
    target: "lead_magnet",
  },
];

// Render the exemplars into a compact prompt block the model can few-shot from.
// All exemplars are included every time (the voice is consistent across
// channels and the set is small), but when a channel is given its matching
// exemplars are floated to the top so the model anchors on the right surface.
export function renderCtaExemplars(channel?: CtaChannel): string {
  const ordered = channel
    ? [
        ...CTA_EXEMPLARS.filter((e) => e.channel === channel),
        ...CTA_EXEMPLARS.filter((e) => e.channel !== channel),
      ]
    : CTA_EXEMPLARS;

  return ordered
    .map(
      (e) =>
        `- [${e.channel} · target: ${e.target}] post about: ${e.postAbout}\n  copyLine: ${e.copyLine}`,
    )
    .join("\n");
}
