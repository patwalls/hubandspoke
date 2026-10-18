// setInterval for dashboard pollers that skips ticks while the tab is hidden.
//
// Every poll is one Heroku router log line, and the log drain has a small
// daily cap (SolarWinds/Papertrail free plan — docs/automation.md → Log
// volume). A dashboard tab left open in the background used to poll all day:
// a content-detail tab alone was ~26k router lines/day. Now hidden tabs go
// quiet, and the first visible moment after a skipped tick polls once so the
// UI catches up straight away.
//
// `ms` may be a function, re-read before every tick, so a poller can run fast
// while work is in flight and slow when idle.

interface VisibilityDoc {
  hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/** Returns a cleanup function, like `() => clearInterval(id)`. */
export function startVisibleInterval(
  fn: () => void,
  ms: number | (() => number),
  doc: VisibilityDoc | undefined = typeof document === "undefined" ? undefined : document,
): () => void {
  let missed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(tick, typeof ms === "function" ? ms() : ms);
  };
  const tick = () => {
    if (stopped) return;
    if (doc?.hidden) missed = true;
    else fn();
    schedule();
  };
  const onVisibility = () => {
    if (doc && !doc.hidden && missed) {
      missed = false;
      fn();
    }
  };
  schedule();
  doc?.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}
