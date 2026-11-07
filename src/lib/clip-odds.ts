/**
 * Clip odds — how a format's clips actually do on an account (project
 * "clip odds", M2–M4, 2026-11-07).
 *
 * The clip writer's own `estimated_views` ran ~10× high on the 473 idea clips
 * that published, and within one video its ORDER was noise too (corr −0.06
 * with lift over the format's usual; docs/build/sql/clip-odds.sql). Nothing
 * about an idea itself (length, hook length, spoken intro, the guess) told
 * apart the clips that beat their usual. What does differ, a lot, is the
 * format on the account: on MATG a Podcast Clip With Hook lands ~0.6× the
 * Instagram usual while its X Quotables land at par.
 *
 * So a format's track record — of its last N clips, how many got more views
 * than the account's usual post on that platform at the time — is what orders
 * a video's ideas, what the "why" chip says, and what the writer anchors its
 * view number on (instead of the reference library's best hits).
 *
 * Pure: the loader is `services/clip-odds.ts`.
 */

export interface PublishedRow {
  brand: string;
  format: string | null;
  /** Primary platform (first of production_items.platform), e.g. "X". */
  platform: string | null;
  views: number;
  /** YYYY-MM-DD. */
  publishedDate: string;
}

export interface FormatOdds {
  brand: string;
  format: string;
  /** The platform most of the format's recent clips went to. */
  platform: string;
  /** Recent clips scored (≤ ODDS_LAST_CLIPS). */
  clips: number;
  /** How many of them beat the account's usual post on their platform. */
  beat: number;
  /** Median / middle half of those clips' views. */
  typicalViews: number;
  p25: number;
  p75: number;
  /** The account's usual post on `platform` now (median, last 90 days). */
  usualViews: number | null;
}

/** Most recent clips of a format that count toward its record. */
export const ODDS_LAST_CLIPS = 20;
/** Fewer scored clips than this says nothing about a format. */
export const ODDS_MIN_CLIPS = 5;
/** "Usual" = median of every post on the platform in this many days before. */
export const USUAL_WINDOW_DAYS = 90;
/** A usual needs at least this many posts behind it, or the clip isn't scored. */
export const USUAL_MIN_POSTS = 5;
/** Clips older than this don't count — the account has moved on. */
export const ODDS_MAX_AGE_DAYS = 365;

const DAY_MS = 86_400_000;

export function oddsKey(brand: string, format: string): string {
  return `${brand}|${format.toLowerCase()}`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(xs: number[]): number {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

function day(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
}

/**
 * Every format's record on every brand in `rows` (published posts with real
 * views). A clip is compared with the usual on ITS platform in the 90 days
 * before it went out, so a format that moved accounts is judged fairly.
 */
export function computeFormatOdds(rows: PublishedRow[], now: Date = new Date()): Map<string, FormatOdds> {
  const nowMs = now.getTime();
  // brand|platform → posts sorted by day, for the trailing usual.
  const byAccount = new Map<string, Array<{ t: number; views: number }>>();
  const byFormat = new Map<string, PublishedRow[]>();
  for (const r of rows) {
    if (!r.platform || !r.publishedDate || !Number.isFinite(r.views)) continue;
    const t = day(r.publishedDate);
    if (Number.isNaN(t)) continue;
    const acct = `${r.brand}|${r.platform}`;
    (byAccount.get(acct) ?? byAccount.set(acct, []).get(acct)!).push({ t, views: r.views });
    if (r.format) {
      const k = oddsKey(r.brand, r.format);
      (byFormat.get(k) ?? byFormat.set(k, []).get(k)!).push(r);
    }
  }
  for (const posts of byAccount.values()) posts.sort((a, b) => a.t - b.t);

  const usualBefore = (brand: string, platform: string, t: number): number | null => {
    const posts = byAccount.get(`${brand}|${platform}`) ?? [];
    const win = posts.filter((p) => p.t < t && p.t >= t - USUAL_WINDOW_DAYS * DAY_MS).map((p) => p.views);
    return win.length >= USUAL_MIN_POSTS ? median(win) : null;
  };

  const out = new Map<string, FormatOdds>();
  for (const [key, clips] of byFormat) {
    const recent = clips
      .filter((c) => day(c.publishedDate) >= nowMs - ODDS_MAX_AGE_DAYS * DAY_MS)
      .sort((a, b) => day(b.publishedDate) - day(a.publishedDate));
    const scored: number[] = [];
    let beat = 0;
    const platformCount = new Map<string, number>();
    for (const c of recent) {
      if (scored.length >= ODDS_LAST_CLIPS) break;
      const usual = usualBefore(c.brand, c.platform!, day(c.publishedDate));
      if (usual == null) continue;
      scored.push(c.views);
      if (c.views > usual) beat++;
      platformCount.set(c.platform!, (platformCount.get(c.platform!) ?? 0) + 1);
    }
    if (scored.length < ODDS_MIN_CLIPS) continue;
    const platform = [...platformCount].sort((a, b) => b[1] - a[1])[0][0];
    const sorted = [...scored].sort((a, b) => a - b);
    out.set(key, {
      brand: clips[0].brand,
      format: clips[0].format!,
      platform,
      clips: scored.length,
      beat,
      typicalViews: Math.round(quantile(sorted, 0.5)),
      p25: Math.round(quantile(sorted, 0.25)),
      p75: Math.round(quantile(sorted, 0.75)),
      usualViews: (() => {
        const u = usualBefore(clips[0].brand, platform, nowMs + DAY_MS);
        return u == null ? null : Math.round(u);
      })(),
    });
  }
  return out;
}

/** Share of recent clips that beat the usual; 0.5 (a coin flip, which is
 *  what "beat the median" is by definition) when the format has no record. */
export function oddsScore(odds: FormatOdds | null | undefined): number {
  return odds ? odds.beat / odds.clips : 0.5;
}

/**
 * Order one video's ideas: formats that beat this account's usual most
 * often first; within a format, in the order they happen in the video (the
 * writer's view guess is not used — it carried no signal within a video).
 */
export function compareIdeasByOdds<T extends { odds?: FormatOdds | null; startSec: number }>(a: T, b: T): number {
  const d = oddsScore(b.odds) - oddsScore(a.odds);
  if (Math.abs(d) > 1e-9) return d;
  return a.startSec - b.startSec;
}

export function compactViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return `${Math.round(n)}`;
}

/** The chip: "11/20 beat usual". */
export function oddsChip(odds: FormatOdds): string {
  return `${odds.beat}/${odds.clips} beat usual`;
}

/** The sentence behind the chip (tooltip / triage line). */
export function oddsWhy(odds: FormatOdds): string {
  const usual = odds.usualViews != null ? ` (about ${compactViews(odds.usualViews)} views now)` : "";
  return (
    `${odds.beat} of the last ${odds.clips} ${odds.format} clips beat this account's usual ${odds.platform} post${usual}. ` +
    `Typical clip: ${compactViews(odds.typicalViews)} views` +
    (compactViews(odds.p25) === compactViews(odds.p75) ? "." : ` (${compactViews(odds.p25)}–${compactViews(odds.p75)}).`)
  );
}

/** Tone of the chip: clearly above / at / clearly below a coin flip. */
export function oddsTone(odds: FormatOdds): "up" | "even" | "down" {
  const s = oddsScore(odds);
  return s >= 0.6 ? "up" : s <= 0.4 ? "down" : "even";
}

/**
 * The writer's REAL OUTCOMES block (hook-v5): this format's actual numbers on
 * the account, so `estimatedViews` anchors on what clips get, not on the
 * reference library's best hits. Null = no record, no block.
 */
export function oddsPromptBlock(odds: FormatOdds | null | undefined): string | null {
  if (!odds) return null;
  const usual = odds.usualViews != null ? ` (the usual ${odds.platform} post gets ~${odds.usualViews.toLocaleString("en-US")} views)` : "";
  return `=====================================================
REAL OUTCOMES — what "${odds.format}" clips actually get on this account
=====================================================

Last ${odds.clips} published ${odds.format} clips on ${odds.platform}: median ${odds.typicalViews.toLocaleString("en-US")} views, middle half ${odds.p25.toLocaleString("en-US")}–${odds.p75.toLocaleString("en-US")}. ${odds.beat} of ${odds.clips} beat the account's usual post${usual}.

The REFERENCE LIBRARY shows this format's best hits, not what a typical clip gets. Set \`estimatedViews\` from these real numbers: start at the median; move toward ${odds.p75.toLocaleString("en-US")} only when this section is clearly stronger than this account's usual clip, and below the median when it is weaker. Going past ${odds.p75.toLocaleString("en-US")} needs a specific reason in the rationale.`;
}
