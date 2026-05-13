"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
  MessageCircleIcon,
  Share2Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { KillIdeaDialog } from "./kill-idea-dialog";

interface ClipIdeaSummary {
  id: string;
  hook: string;
  angle: string;
  rationale: string;
  startSec: number;
  endSec: number;
  estimatedViews: number | null;
  status?: string;
  acceptedEditorName?: string | null;
  acceptedProductionItemId?: string | null;
}

interface PreviewSegment {
  startSec: number;
  endSec: number;
  text: string;
  speaker: string | null;
}

interface Preview {
  videoUrl: string | null;
  videoContentType: string | null;
  segments: PreviewSegment[];
}

interface PromotionFormat {
  id: string;
  name: string;
  brand: string;
  pack: { id: string; name: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea: ClipIdeaSummary | null;
  onDone: () => void;
  brand: string;
  /** Resolved canonical promotion format + its attached Descript pack.
   *  When `pack` is null (or the format itself is null/undefined), all
   *  four "Create in Descript" dropdown items are disabled and the
   *  header links the user back to the format edit page to attach a
   *  pack. Optional because not every place that mounts this dialog has
   *  the data fetched yet (idea-queue-table mounts it in a row context
   *  without the per-source clip-ideas fetch); those callers see the
   *  same "attach a pack" gating until they're upgraded. */
  promotionFormat?: PromotionFormat | null;
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function ClipTriageDialog({
  open,
  onOpenChange,
  idea,
  onDone,
  brand,
  promotionFormat,
}: Props) {
  // When the parent doesn't already pass promotionFormat (e.g. the queue
  // page mounts the dialog without pre-fetching per-row formats), fetch
  // it ourselves on open. Cached for the dialog lifetime.
  const [fetchedFormat, setFetchedFormat] = useState<PromotionFormat | null>(
    null,
  );
  useEffect(() => {
    if (!open || promotionFormat !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/promotion-format?brand=${encodeURIComponent(brand)}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          promotionFormat: PromotionFormat | null;
        };
        if (!cancelled) setFetchedFormat(json.promotionFormat);
      } catch {
        // Leave fetchedFormat null — gating defaults to "no pack".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, brand, promotionFormat]);

  const effectiveFormat: PromotionFormat | null =
    promotionFormat ?? fetchedFormat;
  const packAttached = !!effectiveFormat?.pack;
  const formatHref = effectiveFormat
    ? `/${effectiveFormat.brand}/formats/${effectiveFormat.id}`
    : `/${brand}/formats`;
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Editable hook. Seeded from the server-provided idea on open; edits are
  // flushed to PATCH /api/clip-ideas/:id on blur. The right-side preview
  // reads from this local copy so it updates as the user types.
  const [hookDraft, setHookDraft] = useState("");
  const [hookBaseline, setHookBaseline] = useState("");
  const [hookSaving, setHookSaving] = useState(false);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  // Reseed the hook textarea whenever a new idea opens. Drops any unsaved
  // edits from a previous idea — acceptable because blur-to-save flushes
  // before close in the normal path.
  useEffect(() => {
    if (idea) {
      setHookDraft(idea.hook);
      setHookBaseline(idea.hook);
    }
  }, [idea]);

  const commitHook = useCallback(async () => {
    if (!idea) return;
    const next = hookDraft.trim();
    if (!next || next === hookBaseline) {
      setHookDraft(hookBaseline);
      return;
    }
    setHookSaving(true);
    try {
      const res = await fetch(`/api/clip-ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook: next }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json?.error || `Failed to save hook (${res.status})`);
        setHookDraft(hookBaseline);
        return;
      }
      setHookBaseline(next);
      // Intentionally NOT calling onDone() here. onDone refetches the parent
      // clip-ideas list, and when blur fires from clicking the Create
      // dropdown trigger the parent's re-render races with the dropdown open
      // and collapses the whole dialog. The new hook is already persisted
      // server-side; the parent picks it up on its next natural refetch
      // (after the create-in-descript flow finishes, or when the user
      // closes the dialog).
    } finally {
      setHookSaving(false);
    }
  }, [idea, hookDraft, hookBaseline]);

  // Fetch transcript excerpt + signed video URL whenever the dialog opens on
  // a new idea. Short-circuit while closed — the fetch is cheap but useless
  // if the dialog isn't visible.
  useEffect(() => {
    if (!open || !idea) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    (async () => {
      try {
        const res = await fetch(`/api/clip-ideas/${idea.id}/preview`);
        if (!res.ok) return;
        const json = (await res.json()) as Preview;
        if (!cancelled) setPreview(json);
      } catch {
        // Leave preview null — the dialog renders fine without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, idea]);

  const handleKill = useCallback(
    async (reason: string | null) => {
      if (!idea) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/clip-ideas/${idea.id}/triage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "kill", killReason: reason }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          setError(json?.error || `Failed (${res.status})`);
          return;
        }
        setKillOpen(false);
        onDone();
        onOpenChange(false);
      } finally {
        setSaving(false);
      }
    },
    [idea, onDone, onOpenChange],
  );

  const runCreateInDescript = useCallback(
    async (path: "agent" | "precise" | "precise-ai" | "full") => {
      if (!idea) return;
      setSaving(true);
      setError(null);
      try {
        const url =
          path === "agent"
            ? `/api/clip-ideas/${idea.id}/create-in-descript`
            : path === "precise"
              ? `/api/clip-ideas/${idea.id}/create-in-descript-precise`
              : path === "precise-ai"
                ? `/api/clip-ideas/${idea.id}/create-in-descript-precise?ai=1`
                : `/api/clip-ideas/${idea.id}/create-in-descript-full`;
        const res = await fetch(url, { method: "POST" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json?.error || `Failed (${res.status})`);
          return;
        }
        const newId: string | undefined = json?.newProductionItemId;
        const brandSlug: string = json?.sourceBrand ?? brand;
        const toastTitle =
          path === "agent"
            ? "Cutting clip in Descript (Underlord)…"
            : path === "precise"
              ? "Trimming clip locally and uploading to Descript…"
              : path === "precise-ai"
                ? "Trimming locally, then applying ReelsLayout via Underlord…"
                : json?.mode === "cold"
                  ? "Uploading the full pillar to Descript…"
                  : "Duplicating the pillar composition in Descript…";
        const toastDesc =
          path === "agent"
            ? "The new composition will appear on this item shortly."
            : path === "precise"
              ? "The new Descript project will appear on this item when the upload finishes."
              : path === "precise-ai"
                ? "Two-step: ffmpeg trim → Descript import → Underlord layout pack. The new composition will appear shortly."
                : json?.mode === "cold"
                  ? "First clip from this pillar — uploading once. Future clips will be instant."
                  : "The new composition will appear on this item shortly.";
        toast.success(toastTitle, {
          duration: 6000,
          description: toastDesc,
        });
        onDone();
        onOpenChange(false);
        if (newId) {
          router.push(`/${brandSlug}/content/${newId}`);
        }
      } finally {
        setSaving(false);
      }
    },
    [idea, onDone, onOpenChange, brand, router],
  );

  if (!idea) return null;
  const duration = Math.max(0, Math.round(idea.endSec - idea.startSec));
  const isDecided = idea.status && idea.status !== "suggested";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>The Clip</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4">
              <div className="space-y-4 min-w-0">
                <div className="inline-block text-[11px] font-mono text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    {fmtTs(idea.startSec)}–{fmtTs(idea.endSec)} ({duration}s)
                  </span>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Hook
                  </label>
                  <textarea
                    value={hookDraft}
                    onChange={(e) => setHookDraft(e.target.value)}
                    onBlur={() => void commitHook()}
                    disabled={isDecided || hookSaving}
                    rows={2}
                    placeholder="The first line the viewer hears"
                    className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium leading-snug focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Why it&apos;ll go viral
                  </h3>
                  <p className="text-[13px] leading-relaxed text-foreground/90">
                    {idea.rationale}
                  </p>
                </div>

                {preview && preview.segments.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Transcript
                    </h3>
                    <div className="max-h-48 overflow-y-auto text-[13px] leading-relaxed text-muted-foreground">
                      {preview.segments
                        .map((s) => s.text.trim())
                        .filter(Boolean)
                        .join(" ")}
                    </div>
                  </div>
                )}

                {isDecided && (
                  <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-900">
                    <span>
                      {idea.status === "assigned" && idea.acceptedEditorName ? (
                        <>
                          <span className="font-medium">Assigned</span> to{" "}
                          {idea.acceptedEditorName}
                        </>
                      ) : idea.status === "killed" ? (
                        <span className="font-medium text-muted-foreground">
                          This idea was killed.
                        </span>
                      ) : (
                        <span className="font-medium">
                          {idea.status === "accepted"
                            ? "Accepted"
                            : "Already decided"}
                        </span>
                      )}
                    </span>
                    {idea.acceptedProductionItemId && (
                      <a
                        href={`/${brand}/content/${idea.acceptedProductionItemId}`}
                        className="text-blue-700 hover:underline font-medium"
                      >
                        View content →
                      </a>
                    )}
                  </div>
                )}

                {error && <p className="text-xs text-red-600">{error}</p>}
              </div>

              <div className="self-center">
                <ShortsPreview
                  hook={hookDraft || idea.hook}
                  startSec={idea.startSec}
                  endSec={idea.endSec}
                  preview={preview}
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-3 mt-4">
              {isDecided ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => setKillOpen(true)}
                  disabled={saving}
                  className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  Kill idea
                </button>
              )}
              <div className="flex items-center gap-2">
                {!isDecided && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={saving}
                      className={buttonVariants({ variant: "default" })}
                    >
                      Create
                      <ChevronDownIcon className="size-3.5 ml-1" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                      <div className="px-2 py-2 border-b border-border">
                        {packAttached ? (
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            Pack:{" "}
                            <span className="font-medium text-foreground">
                              {effectiveFormat!.pack!.name}
                            </span>{" "}
                            —{" "}
                            <a
                              href={formatHref}
                              className="text-primary hover:underline"
                            >
                              edit at format →
                            </a>
                          </p>
                        ) : (
                          <p className="text-[11px] text-amber-700 leading-snug">
                            <span className="font-medium">
                              No Descript pack attached.
                            </span>{" "}
                            <a
                              href={formatHref}
                              className="text-primary hover:underline"
                            >
                              Attach one at the format →
                            </a>
                          </p>
                        )}
                      </div>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("full")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Full video — no AI
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Reuses the pillar&apos;s Descript project (uploads
                          once) and duplicates the composition. Editor trims
                          manually — no Underlord call.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("precise")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Precise cut — no AI
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          ffmpeg-trims the source to the exact range and
                          uploads a new Descript project. Frame-accurate, no
                          Underlord call.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("agent")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Full video + Underlord
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Fast. New composition in the source project.
                          Underlord cuts by transcript, applies the format&apos;s
                          pack (9:16 + hook track + captions), and ignores
                          filler words.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("precise-ai")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Precise cut + Underlord
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          ffmpeg-trims to the exact range, uploads a new
                          Descript project, then Underlord applies the
                          format&apos;s pack and ignores fillers. Two Descript
                          jobs.
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <KillIdeaDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title={idea.hook}
        saving={saving}
        onConfirm={handleKill}
      />
    </>
  );
}

function ShortsPreview({
  hook,
  startSec,
  endSec,
  preview,
}: {
  hook: string;
  startSec: number;
  endSec: number;
  preview: Preview | null;
}) {
  const captionText =
    preview?.segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ") ?? "";
  const isAudio = preview?.videoContentType?.startsWith("audio/");

  return (
    <div
      className="relative mx-auto w-full max-w-[320px] rounded-xl bg-black text-white overflow-hidden flex flex-col shadow-lg"
      style={{ aspectRatio: "9 / 16" }}
    >
      {/* Hook pinned to top. Video fills the middle (flex-1 + items-center).
          Caption and reaction rail sit absolute at the bottom so they overlay
          the video like a real Reel. Parent is `relative` so the absolute
          children anchor inside the canvas, not the dialog. */}
      <div className="px-8 pt-3 z-10">
        <p className="text-[15px] font-extrabold leading-tight line-clamp-3 text-center">
          {hook}
        </p>
      </div>

      <div className="flex-1 flex items-center justify-center min-h-0">
        {preview?.videoUrl ? (
          isAudio ? (
            <audio
              key={`${preview.videoUrl}-audio`}
              src={`${preview.videoUrl}#t=${startSec},${endSec}`}
              controls
              preload="metadata"
              className="w-full px-3"
            />
          ) : (
            <video
              key={`${preview.videoUrl}-video`}
              src={`${preview.videoUrl}#t=${startSec},${endSec}`}
              controls
              preload="metadata"
              playsInline
              className="h-full w-full bg-black object-contain"
            />
          )
        ) : (
          <div className="text-[11px] text-white/50">
            {preview === null ? "Loading preview…" : "No preview available"}
          </div>
        )}
      </div>

      {captionText && (
        <div className="absolute inset-x-0 bottom-14 px-8 text-center pointer-events-none">
          <p className="text-[13px] font-semibold leading-snug line-clamp-3 drop-shadow-lg">
            {captionText}
          </p>
        </div>
      )}

      <div className="absolute right-1.5 bottom-3 flex flex-col items-center gap-3 text-white/85 pointer-events-none drop-shadow-lg">
        <ThumbsUpIcon className="h-5 w-5" strokeWidth={1.8} />
        <ThumbsDownIcon className="h-5 w-5" strokeWidth={1.8} />
        <MessageCircleIcon className="h-5 w-5" strokeWidth={1.8} />
        <Share2Icon className="h-5 w-5" strokeWidth={1.8} />
      </div>
    </div>
  );
}
