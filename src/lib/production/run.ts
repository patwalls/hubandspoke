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
 */
export const RUN_KEY = "hs:production-run";
export const RUN_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Big status groups (Published) can hold thousands of rows; past this the
 *  stepper is still useful and the storage stays small. */
export const RUN_MAX_ROWS = 500;

export interface RunRow {
  id: string;
  title: string;
}

export interface ProductionRun {
  brand: string;
  /** The status group's name, e.g. "Review". */
  group: string;
  rows: RunRow[];
  at: number;
}

export interface RunPosition {
  group: string;
  /** 1-based, for "3 of 12". */
  index: number;
  total: number;
  prev: RunRow | null;
  next: RunRow | null;
}

export function encodeRun(run: Omit<ProductionRun, "at">, now: number): string {
  return JSON.stringify({ ...run, rows: run.rows.slice(0, RUN_MAX_ROWS), at: now } satisfies ProductionRun);
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
    return { brand: v.brand, group: v.group, rows, at: v.at };
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
    group: run.group,
    index: i + 1,
    total: run.rows.length,
    prev: run.rows[i - 1] ?? null,
    next: run.rows[i + 1] ?? null,
  };
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

export function readRun(brand: string): ProductionRun | null {
  try {
    return decodeRun(window.sessionStorage.getItem(RUN_KEY), brand, Date.now());
  } catch {
    return null;
  }
}
