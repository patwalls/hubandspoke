"use client";

/**
 * Draft awareness outside the editor: which queue rows have an edit in
 * progress, and keeping the open editor in the URL so a reload (or a crash)
 * lands back in it.
 *
 * Everything here is inert without the `clipEditor` flag — the hook returns
 * nothing and the badge renders null, so mounting them in shared queue code
 * changes nothing for anyone else.
 */
import { useEffect, useState } from "react";
import { PencilLineIcon } from "lucide-react";
import { useFeatureFlags } from "./use-feature-flags";

// ── URL state ──────────────────────────────────────────────────────────────
// `?clip=<clipIdeaId>` while the editor is open. Written with
// history.replaceState rather than the Next router: this is a bookmark of UI
// state, not a navigation, and a router.replace here would re-render the
// whole queue page underneath the editor on every open/close.

export const CLIP_PARAM = "clip";

export function readClipParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(CLIP_PARAM);
}

export function writeClipParam(clipIdeaId: string | null): void {
  const url = new URL(window.location.href);
  if (clipIdeaId) url.searchParams.set(CLIP_PARAM, clipIdeaId);
  else url.searchParams.delete(CLIP_PARAM);
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url);
  }
}

// ── Draft list (module-cached, shared by every row) ────────────────────────

let drafts: Set<string> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (!inflight) {
    inflight = fetch("/api/clip-edits/drafts")
      .then((res) => (res.ok ? res.json() : { drafts: [] }))
      .then((json: { drafts: Array<{ clipIdeaId: string }> }) => {
        drafts = new Set(json.drafts.map((d) => d.clipIdeaId));
        listeners.forEach((l) => l());
      })
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Re-read the draft list — call when an editor closes or exports. */
export function refreshClipDrafts(): void {
  void load();
}

export function ClipDraftBadge({ clipIdeaId }: { clipIdeaId: string | null | undefined }) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.clipEditor;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const onChange = () => rerender((n) => n + 1);
    listeners.add(onChange);
    if (drafts === null) void load();
    return () => {
      listeners.delete(onChange);
    };
  }, [enabled]);

  if (!enabled || !clipIdeaId || !drafts?.has(clipIdeaId)) return null;
  return (
    <span
      title="You have a saved draft of this clip — open it to keep editing"
      className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-800 dark:bg-sky-950 dark:text-sky-300"
    >
      <PencilLineIcon className="size-3" />
      Draft
    </span>
  );
}
