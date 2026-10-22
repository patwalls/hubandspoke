// Screenshot placeholders in a newsletter draft (sections whose template setting asks for screenshots) — `*[Screenshot @ 4:32: the
// Skills page with Record selected]*` — and the frames chosen for them.
// The drafter tags each with the moment in the video it shows (it gets the
// timestamped transcript); the editor grabs frames around that moment from the
// archived video and the editor picks one; the preview and the beehiiv push
// swap the chosen frame in for the placeholder. Structural parsing of our own
// placeholder syntax. Pure (shared by the browser and the server).

export interface ScreenshotMark {
  /** Stable per draft: section key + the placeholder's description. */
  key: string;
  sectionKey: string;
  /** Seconds into the video, when the placeholder has a timestamp. */
  sec: number | null;
  label: string;
  /** The placeholder as written (including surrounding * or _). */
  raw: string;
}

/**
 * The image chosen for a placeholder (stored on newsletter_drafts.screenshots,
 * keyed by ScreenshotMark.key): a frame grabbed from the video (picked
 * automatically when the draft lands, or by hand), or an image the editor
 * uploaded.
 */
export interface ChosenScreenshot {
  /** The design_frames row, for a video frame; null for an upload. */
  frameId: string | null;
  /** Video moment (frames only). */
  sec: number | null;
  /** Empty while `pending`. */
  bucket: string;
  key: string;
  source?: "frame" | "upload" | "auto";
  /** The frame is still being grabbed (filled in by resolvePendingScreenshots). */
  pending?: boolean;
}

const MARK = /[*_]?\[Screenshot(?:\s*@\s*(\d{1,2}(?::\d{2}){1,2}))?\s*:\s*([^\]]+?)\s*\][*_]?/gi;

/** "4:32" → 272, "1:02:03" → 3723. */
export function parseTimestamp(ts: string): number {
  return ts.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function screenshotKey(sectionKey: string, label: string): string {
  return `${sectionKey}:${label.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`;
}

/** Every screenshot placeholder in a section's Markdown, in order. */
export function parseScreenshotMarks(sectionKey: string, markdown: string): ScreenshotMark[] {
  const out: ScreenshotMark[] = [];
  for (const m of markdown.matchAll(MARK)) {
    const label = m[2].trim();
    out.push({ key: screenshotKey(sectionKey, label), sectionKey, sec: m[1] ? parseTimestamp(m[1]) : null, label, raw: m[0] });
  }
  return out;
}

/** Replace every screenshot placeholder in `markdown` with `fn(sec, label)`. */
export function replaceScreenshotMarks(markdown: string, fn: (sec: number | null, label: string) => string): string {
  return markdown.replace(MARK, (_raw, ts: string | undefined, label: string) => fn(ts ? parseTimestamp(ts) : null, label.trim()));
}

/**
 * The section's Markdown with each placeholder that has a chosen frame
 * replaced by an image line (`![label](url)` on its own line). `urlFor` maps
 * a chosen frame to the URL to show (a preview link in the browser, the
 * public link for beehiiv). Placeholders without a frame stay as they are.
 */
export function applyScreenshots(
  sectionKey: string,
  markdown: string,
  chosen: Record<string, ChosenScreenshot> | null | undefined,
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null,
): string {
  if (!chosen || !Object.keys(chosen).length) return markdown;
  return markdown.replace(MARK, (raw, _ts: string, label: string) => {
    const markKey = screenshotKey(sectionKey, label);
    const c = chosen[markKey];
    const url = c ? urlFor(c, markKey) : null;
    return url ? `\n![${label.trim().replace(/[[\]]/g, "")}](${url})\n` : raw;
  });
}

/** A step title line: "**4. Title**", "**4. Title.** body" or "4. **Title.** body". */
const STEP_TITLE = /^\s*(?:\*\*(\d+)\.\s|(\d+)\.\s+\*\*)/;
const HAS_IMAGE = /!\[[^\]]*\]\([^)]*\)|\[Screenshot/i;

export interface StepSpot {
  /** The step's number as written. */
  n: number;
  /** The step's text (title + explanation), for finding its moment in the video. */
  text: string;
  /** Line index a screenshot goes after: the step's first line of explanation. */
  after: number;
}

/**
 * Numbered steps with no screenshot or image yet, and where one would go
 * (after the step's first line of explanation, as in the Kevin/Saj
 * templates). Structural parsing of our own step layout. Pure.
 */
export function stepsWithoutScreenshots(markdown: string): StepSpot[] {
  const lines = markdown.split("\n");
  const titles = lines.flatMap((l, i) => {
    const m = l.match(STEP_TITLE);
    return m ? [{ i, n: Number(m[1] ?? m[2]), open: m[0].length }] : [];
  });
  return titles.flatMap(({ i, n, open }, k) => {
    const end = k + 1 < titles.length ? titles[k + 1].i : lines.length;
    const block = lines.slice(i, end);
    if (block.some((l) => HAS_IMAGE.test(l))) return [];
    const close = lines[i].indexOf("**", open);
    const inlineBody = close >= 0 && lines[i].slice(close + 2).trim().length > 0;
    let after = i;
    if (!inlineBody) {
      for (let j = i + 1; j < end; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (!/^#{1,4}\s/.test(t)) after = j;
        break;
      }
    }
    return [{ n, text: block.join("\n").trim(), after }];
  });
}

/** `markdown` with `placeholder` on its own line after step `n`'s first line of explanation (unchanged if that step has an image). Pure. */
export function insertStepScreenshot(markdown: string, n: number, placeholder: string): string {
  const spot = stepsWithoutScreenshots(markdown).find((s) => s.n === n);
  if (!spot) return markdown;
  const lines = markdown.split("\n");
  lines.splice(spot.after + 1, 0, "", placeholder, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `markdown` without the placeholder `markKey` (the whole screenshot, not just its image). Pure. */
export function removeScreenshotMark(markdown: string, sectionKey: string, markKey: string): string {
  return markdown
    .replace(MARK, (raw, _ts: string, label: string) => (screenshotKey(sectionKey, label) === markKey ? "" : raw))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
