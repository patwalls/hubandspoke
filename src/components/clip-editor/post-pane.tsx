"use client";

/**
 * The Post tab of the clip editor — the copy this clip goes out with.
 *
 * There is one draft, with two doors: this pane and the content page both
 * edit the item's current `content_drafts` row through the same simulator
 * (ContentPreview → the platform mock), so what you write here is exactly
 * what the content page shows after export. The draft itself is written by
 * the Draft Algorithm the moment the editor opens (session.ts), grounded in
 * the words the cut keeps; Redraft re-runs it against the current cut.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import type { ContentDraftContent } from "@/lib/db/schema";
import type { ProductionItem } from "@/types";
import type { ClipPost } from "@/lib/services/clip-editor/post-draft";
import { ContentPreview } from "@/components/dashboard/preview/content-preview";
import type { EnrichmentMedia } from "@/components/dashboard/enrichment-dialog";

interface DraftRow {
  id: string;
  content: ContentDraftContent;
}

interface DetailResponse {
  item: ProductionItem;
  media: EnrichmentMedia[];
  currentDraft: DraftRow | null;
}

const POLL_MS = 3_000;

export function PostPane({
  post,
  brand,
  onDraftingChange,
  beforeRedraft,
}: {
  post: ClipPost;
  brand: string;
  /** Lets the tab strip show a spinner while the post is being written. */
  onDraftingChange?: (drafting: boolean) => void;
  /** Flush the clip's edits first, so a redraft reads the current cut.
   *  Resolve false to abort. */
  beforeRedraft?: () => Promise<boolean>;
}) {
  const itemId = post.productionItemId;
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveContent, setLiveContent] = useState<ContentDraftContent | null>(null);
  // null = not asked yet; the algorithm is queued or mid-flight while true.
  const [running, setRunning] = useState<boolean | null>(post.state === "drafting" ? true : null);
  const [redrafting, setRedrafting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/production-items/${itemId}`);
      if (!res.ok) throw new Error(`Couldn't load the post (${res.status})`);
      const json = (await res.json()) as DetailResponse;
      setDetail(json);
      setLiveContent(json.currentDraft?.content ?? null);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the post");
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the algorithm: poll while it runs; when it stops, pull the fresh
  // draft in. Also settles the initial "is it running?" question. Stops once
  // the queue is idle — with a draft, or after a second idle look without
  // one (the run was skipped; Redraft is the way forward).
  const wasRunning = useRef(running === true);
  const idleLooks = useRef(0);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/production-items/${itemId}/draft-algorithm-status`);
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { state: "idle" | "running" };
        const now = json.state === "running";
        if (cancelled) return;
        setRunning(now);
        if (wasRunning.current && !now) void load();
        wasRunning.current = now;
        idleLooks.current = now ? 0 : idleLooks.current + 1;
        if (!now && (detail?.currentDraft || idleLooks.current >= 2)) setSettled(true);
      } catch {
        // leave the state as it was; the next tick retries
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [itemId, load, settled, detail?.currentDraft]);

  const drafting = running === true || redrafting;
  useEffect(() => {
    onDraftingChange?.(drafting);
  }, [drafting, onDraftingChange]);

  const onLocalEdit = useCallback((fieldKey: string, value: string | string[]) => {
    setLiveContent((prev) => ({ ...(prev ?? {}), [fieldKey]: value }));
  }, []);

  // Blur-save one field, the same clone-on-write PUT the content page uses.
  const onCommit = useCallback(
    async (fieldKey: string) => {
      const draft = detail?.currentDraft;
      if (!draft) return;
      const next = liveContent?.[fieldKey];
      if (next === draft.content[fieldKey] || (next == null && draft.content[fieldKey] == null)) return;
      try {
        const res = await fetch(`/api/production-items/${itemId}/drafts/${draft.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: { [fieldKey]: next } }),
        });
        const json = (await res.json().catch(() => ({}))) as { draft?: DraftRow; error?: string };
        const saved = json.draft;
        if (!res.ok || !saved) throw new Error(json.error ?? `HTTP ${res.status}`);
        setDetail((d) => (d ? { ...d, currentDraft: saved } : d));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't save the post");
      }
    },
    [detail?.currentDraft, itemId, liveContent],
  );

  const redraft = async () => {
    setRedrafting(true);
    setSettled(false);
    try {
      if (beforeRedraft && !(await beforeRedraft())) {
        toast.error("Couldn't save the clip's edits — redraft cancelled");
        return;
      }
      const res = await fetch(`/api/production-items/${itemId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, userInitiated: true }),
      });
      const json = (await res.json().catch(() => ({}))) as { status?: string; reason?: string; error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't redraft the post");
        return;
      }
      if (json.status === "skipped") {
        toast.message("Nothing to draft from", { description: json.reason });
        return;
      }
      await load();
    } finally {
      setRedrafting(false);
    }
  };

  const draft = detail?.currentDraft ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <h3 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Post
        </h3>
        {drafting && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" /> Writing…
          </span>
        )}
        <button
          type="button"
          disabled={drafting || !detail}
          onClick={() => void redraft()}
          title="Write the post again from the words this cut keeps. Replaces the current text (the old version stays in the item's history)."
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          <SparklesIcon className="size-3" /> {draft ? "Redraft" : "Draft the post"}
        </button>
        <a
          href={`/${brand}/content/${itemId}`}
          target="_blank"
          rel="noreferrer"
          title="Open the content page"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {loadError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{loadError}</p>
        ) : !detail ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
        ) : draft ? (
          <ContentPreview
            item={detail.item}
            media={detail.media}
            draftId={draft.id}
            liveContent={liveContent}
            onLocalEdit={onLocalEdit}
            onCommit={(k) => void onCommit(k)}
            onMediaMutated={() => void load()}
            onDraftMutated={() => void load()}
            draftAlgorithmRunning={drafting}
          />
        ) : drafting ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            <p className="text-sm font-medium">Writing the post from this clip…</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              The draft uses the words your cut keeps, the format&apos;s playbook and its best past posts.
              Usually under a minute — keep editing the clip meanwhile.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <p className="text-sm font-medium">No post yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              The draft couldn&apos;t be written automatically — usually the source has no transcript yet.
              Try again, or write it on the content page after export.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
