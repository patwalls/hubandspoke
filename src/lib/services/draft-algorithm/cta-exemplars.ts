// Curated, representative CTA exemplars — the "training data" for the smart CTA
// generator. We don't store real published CTAs anywhere, so this is a
// hand-written starter set encoding the house style Pat described:
//
//   <one-liner that ends with a colon>
//   <link>
//
// The generator only writes the FIRST line (the `copyLine`, ending in a colon);
// the tracked go.starterstory.com link is appended programmatically. So these
// exemplars teach two things: (1) the voice/shape of that one-liner, and
// (2) when to point at a guest's episode vs. a lead magnet.
//
// Pat: edit/expand this freely — add real published CTAs as you collect them.
// Keep `copyLine` ending in a colon and keep it a single line.

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

export const CTA_EXEMPLARS: CtaExemplar[] = [
  // ── Guest-specific posts → link to the episode ──────────────────────────
  {
    channel: "x",
    postAbout:
      "A post built around one founder's story (e.g. how Sara grew her brand to $1M).",
    copyLine: "Here's the full story of how she pulled it off:",
    target: "episode",
  },
  {
    channel: "linkedin",
    postAbout: "A profile of a specific founder and their playbook.",
    copyLine: "We went deep with him on the whole journey here:",
    target: "episode",
  },
  {
    channel: "ytcommunity",
    postAbout: "A clip teasing a guest interview.",
    copyLine: "Watch the full interview:",
    target: "episode",
  },
  {
    channel: "threads",
    postAbout: "A short hook about a guest's surprising tactic.",
    copyLine: "The full breakdown is right here:",
    target: "episode",
  },

  // ── Topic / observation posts → link to the best-fit lead magnet ─────────
  {
    channel: "x",
    postAbout: "An observation about micro-SaaS / small software bets.",
    copyLine: "We put 52 micro-SaaS ideas making millions in one free report:",
    target: "lead_magnet",
  },
  {
    channel: "x",
    postAbout: "A take on solo founders / one-person businesses.",
    copyLine: "Steal the playbook from 50 solo devs making $10K+/mo:",
    target: "lead_magnet",
  },
  {
    channel: "linkedin",
    postAbout: "A trend post about digital products.",
    copyLine: "Grab our free report on 102 digital products making millions:",
    target: "lead_magnet",
  },
  {
    channel: "ytcommunity",
    postAbout: "A general 'how to find an idea' video.",
    copyLine: "Get the full list of million-dollar problems worth solving:",
    target: "lead_magnet",
  },
  {
    channel: "threads",
    postAbout: "A punchy take on starting lean.",
    copyLine: "Here are 130+ solopreneur business ideas to start this weekend:",
    target: "lead_magnet",
  },
];

// Render the exemplars into a compact prompt block the model can few-shot from.
// Optionally filter to a single channel so each generation sees the most
// relevant voice first (falls back to all channels when a channel has none).
export function renderCtaExemplars(channel?: CtaChannel): string {
  const scoped = channel
    ? CTA_EXEMPLARS.filter((e) => e.channel === channel)
    : CTA_EXEMPLARS;
  const pool = scoped.length > 0 ? scoped : CTA_EXEMPLARS;

  return pool
    .map(
      (e) =>
        `- [${e.channel} · target: ${e.target}] post about: ${e.postAbout}\n  copyLine: ${e.copyLine}`,
    )
    .join("\n");
}
