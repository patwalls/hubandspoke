/**
 * The production list you opened a post from, remembered for the content page.
 *
 * People work the In Production list one row at a time: open a post, act,
 * go back to the list, open the next. That round trip is the most common
 * move in the app after "list → post". So when a row is opened, its status
 * group (in the order on screen, after filters and sort) is kept in
 * sessionStorage (tab-scoped), and the content page shows where you are in it
 * ("Review · 3 of 12") with previous / next, plus a back link to the list
 * you came from instead of the Content tab.
 *
 * Kept for a working session only. A run from this morning would step
 * through rows that have moved since.
 *
 * The Content list keeps the same kind of run (content-list-fast M4): the
 * rows in the order on screen after search, filters and sort, with
 * `source: "content"`, so the post steps through that list and its back link
 * says "← Content". One run per tab: opening a row from either list replaces it.
 */
export const RUN_KEY = "hs:production-run";
export const RUN_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Big status groups (Published) can hold thousands of rows; past this the
 *  stepper is still useful and the storage stays small. */
export const RUN_MAX_ROWS = 500;
/** The Content list is one group of every post in the date range (a brand's
 *  90 days is ~1,400 rows); ids and titles only, ~150 KB at this cap. */
export const CONTENT_RUN_MAX_ROWS = 3000;

export interface RunRow {
  id: string;
  title: string;
}

/** The list a run was opened from. Missing = "production" (runs saved
 *  before content-list-fast M4). */
export type RunSource = "production" | "content";

export interface ProductionRun {
  brand: string;
  source?: RunSource;
  /** The status group's name, e.g. "Review". */
  group: string;
  rows: RunRow[];
  at: number;
  /** The post last open on the content page: back on the list, its row has
   *  the keyboard focus (M2). */
  current?: string;
}

export interface RunPosition {
  source: RunSource;
  group: string;
  /** 1-based, for "3 of 12". */
  index: number;
  total: number;
  prev: RunRow | null;
  next: RunRow | null;
}

export function encodeRun(run: Omit<ProductionRun, "at">, now: number): string {
  const cap = run.source === "content" ? CONTENT_RUN_MAX_ROWS : RUN_MAX_ROWS;
  return JSON.stringify({ ...run, rows: run.rows.slice(0, cap), at: now } satisfies ProductionRun);
}

/** The remembered run, or null when missing, malformed, stale or from another brand. */
export function decodeRun(raw: string | null, brand: string, now: number): ProductionRun | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProductionRun>;
    if (typeof v.at !== "number" || now - v.at > RUN_MAX_AGE_MS || now < v.at) return null;
    if (v.brand !== brand || typeof v.group !== "string" || !Array.isArray(v.rows)) return null;
    const rows = v.rows.filter(
      (r): r is RunRow => !!r && typeof r.id === "string" && typeof r.title === "string",
    );
    const current = typeof v.current === "string" ? v.current : undefined;
    const source: RunSource = v.source === "content" ? "content" : "production";
    return { brand: v.brand, source, group: v.group, rows, at: v.at, ...(current ? { current } : {}) };
  } catch {
    return null;
  }
}

/** Where `currentId` sits in the run, or null when the post isn't in it
 *  (opened from somewhere else) or the run is a single row. */
export function positionInRun(run: ProductionRun | null, currentId: string): RunPosition | null {
  if (!run || run.rows.length < 2) return null;
  const i = run.rows.findIndex((r) => r.id === currentId);
  if (i < 0) return null;
  return {
    source: run.source ?? "production",
    group: run.group,
    index: i + 1,
    total: run.rows.length,
    prev: run.rows[i - 1] ?? null,
    next: run.rows[i + 1] ?? null,
  };
}

/**
 * The run after `id` left its status group (its status changed on the
 * content page, M3): the row is dropped, and the one to offer next is the row
 * after it, or the first row when it was the last. Null when the post isn't
 * in the run (opened from elsewhere).
 */
export function leaveRun(
  run: ProductionRun | null,
  id: string,
): { run: ProductionRun; next: RunRow | null } | null {
  // A post leaving a status group only matters to a run of status groups:
  // the Content list keeps every status.
  if (!run || run.source === "content") return null;
  const i = run.rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const rows = run.rows.filter((r) => r.id !== id);
  return { run: { ...run, rows }, next: rows[i] ?? rows[0] ?? null };
}

/**
 * The list's keyboard cursor after a key (M2): j / ↓ down, k / ↑ up, clamped
 * to the list. From no row (-1) either key lands on the first row. Null for
 * any other key, or an empty list.
 */
export function stepFocus(index: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (index < 0 || index >= count) {
    return key === "j" || key === "ArrowDown" || key === "k" || key === "ArrowUp" ? 0 : null;
  }
  if (key === "j" || key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "k" || key === "ArrowUp") return Math.max(index - 1, 0);
  return null;
}

/** Is a keypress meant for a field (typing a caption) rather than the page? */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox";
}

export function rememberRun(run: Omit<ProductionRun, "at">): void {
  try {
    window.sessionStorage.setItem(RUN_KEY, encodeRun(run, Date.now()));
  } catch {
    // Private mode / storage full: the content page just shows no stepper.
  }
}

/** Rewrite the remembered run (a row left it, or the open post changed) without
 *  restarting its 3-hour clock. */
export function saveRun(run: ProductionRun): void {
  try {
    window.sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch {
    // Same as rememberRun.
  }
}

export function readRun(brand: string): ProductionRun | null {
  try {
    return decodeRun(window.sessionStorage.getItem(RUN_KEY), brand, Date.now());
  } catch {
    return null;
  }
}
