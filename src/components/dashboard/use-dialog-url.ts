"use client";

/**
 * A queue dialog that lives in the URL.
 *
 * Opening a row's dialog pushes `?<param>=<id>` (a history entry), so the
 * open post has a link you can send or reload; closing it goes back to the
 * queue (browser Back closes it too). On mount, a row whose id the URL names
 * opens itself — that's the reload / shared-link case.
 *
 * Only history is touched (`pushState` / `back` / `replaceState`); no
 * navigation, no re-render of the page. Next's app router keeps
 * `useSearchParams` in step with native history calls.
 */
import { useCallback, useEffect, useRef } from "react";

export function readUrlParam(param: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(param);
}

function withParam(param: string, value: string | null): URL {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(param, value);
  else url.searchParams.delete(param);
  return url;
}

/** Set/clear a param in place (no history entry) — for ids that become
 *  known after the dialog opened (the item a candidate turned into). */
export function replaceUrlParam(param: string, value: string | null): void {
  const url = withParam(param, value);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export function useDialogUrl(args: { param: string; id: string | null | undefined; open: boolean; onOpenChange: (open: boolean) => void; enabled?: boolean }): void {
  const { param, id, open, onOpenChange } = args;
  const enabled = args.enabled ?? true;
  const pushed = useRef(false);
  const restored = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  // Restore: the URL names this row → open it (once per mount).
  useEffect(() => {
    if (!enabled || !id || restored.current) return;
    restored.current = true;
    if (!open && readUrlParam(param) === id) onOpenChangeRef.current(true);
  }, [enabled, id, param, open]);

  // Open → push the param; close → back (if we pushed) or drop the param.
  useEffect(() => {
    if (!enabled || !id) return;
    if (open) {
      if (readUrlParam(param) !== id) {
        window.history.pushState({ ...(window.history.state ?? {}), dialogParam: param }, "", withParam(param, id));
        pushed.current = true;
      }
      return;
    }
    if (readUrlParam(param) !== id) return; // already gone (Back closed it)
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      replaceUrlParam(param, null);
    }
  }, [enabled, id, param, open]);

  // Browser Back while open → the param is gone → close without pushing/popping again.
  const onPop = useCallback(() => {
    if (open && readUrlParam(param) !== id) {
      pushed.current = false;
      onOpenChangeRef.current(false);
    }
  }, [open, param, id]);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled, onPop]);
}
