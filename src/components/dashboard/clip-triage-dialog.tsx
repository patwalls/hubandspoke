"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  BarChart2Icon,
  BookmarkIcon,
  ChevronDownIcon,
  HeartIcon,
  MessageCircleIcon,
  RepeatIcon,
  Share2Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UploadIcon,
} from "lucide-react";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { SocialEmbedHeader } from "./preview/social-embed-header";

interface ClipIdeaSummary {
  id: string;
  hook: string;
  angle: string;
  rationale: string;
  startSec: number;
  endSec: number;
  estimatedViews: number | null;
  status?: string;
  descriptAttempts?: number;
  acceptedEditorName?: string | null;
  acceptedProductionItemId?: string | null;
  /** Target format name this idea was generated for. Surfaced in the
   *  triage header so the operator knows which format routing this idea
   *  will follow when promoted. */
  targetFormat?: string | null;
  /** Post type of the queue-side production_item created at generation
   *  time (`x`, `instagram_reel`, `tiktok`, …). Drives the choice of
   *  preview simulator on the right side of the dialog. */
  targetPostType?: string | null;
  /** Brand account that will publish this clip (resolved from the
   *  queue-side production_item's accountId at generation time). Drives
   *  the per-platform preview's header — display name, @handle, avatar. */
  targetAccount?: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    platform: string;
    verified: boolean | null;
  } | null;
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
  /** Opening lines of the source, for the "include intro" hook picker. */
  introSegments: PreviewSegment[];
  /** Currently-saved prepended hook ranges (ordered). */
  hookSegments: { startSec: number; endSec: number }[];
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
  // "Include intro" — prepend the whole intro (every opening line the source
  // gives us) as spoken footage ahead of the clip body. Persisted as the one
  // hook range [first intro line start, last intro line end] in
  // clipIdeas.hookSegments.
  const [includeIntro, setIncludeIntro] = useState(false);
  const [introSaving, setIntroSaving] = useState(false);

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
      // Clear intro state on idea switch; the preview-seed effect re-applies
      // the saved hookSegments once the new idea's preview lands.
      setIncludeIntro(false);
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

  // Seed the "include intro" toggle from the saved hookSegments whenever a
  // fresh preview lands — intro is all-or-nothing now, so a non-empty saved
  // range just means the toggle is on.
  useEffect(() => {
    if (!preview) return;
    setIncludeIntro((preview.hookSegments ?? []).length > 0);
  }, [preview]);

  const introSegs = preview?.introSegments ?? [];

  // The whole intro as one contiguous range (first intro line start → last
  // intro line end), and its joined text. null when there's no intro to use.
  const wholeIntroRange =
    introSegs.length > 0
      ? {
          startSec: introSegs[0].startSec,
          endSec: introSegs[introSegs.length - 1].endSec,
        }
      : null;
  const introText = introSegs
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");

  const saveHookSegments = useCallback(
    async (segs: { startSec: number; endSec: number }[] | null) => {
      if (!idea) return;
      setIntroSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/clip-ideas/${idea.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hookSegments: segs }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          setError(json?.error || `Failed to save intro (${res.status})`);
        }
      } finally {
        setIntroSaving(false);
      }
    },
    [idea],
  );

  const toggleIntro = useCallback(
    (checked: boolean) => {
      setIncludeIntro(checked);
      void saveHookSegments(checked && wholeIntroRange ? [wholeIntroRange] : null);
    },
    [wholeIntroRange, saveHookSegments],
  );

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
    async (path: "agent" | "precise" | "buffered" | "full" | "full-range") => {
      if (!idea) return;
      setSaving(true);
      setError(null);
      try {
        const url =
          path === "agent"
            ? `/api/clip-ideas/${idea.id}/create-in-descript`
            : path === "precise"
              ? `/api/clip-ideas/${idea.id}/create-in-descript-precise?ai=1`
              : path === "buffered"
                ? `/api/clip-ideas/${idea.id}/create-in-descript-precise?buffered=1`
                : path === "full-range"
                  ? `/api/clip-ideas/${idea.id}/create-in-descript-full?range=1`
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
            ? "Creating clip with Underlord…"
            : path === "precise"
              ? "Trimming clip and uploading to Descript…"
              : path === "buffered"
                ? "Trimming with 60-second buffer and uploading to Descript…"
                : json?.mode === "cold"
                  ? "Uploading the full pillar to Descript…"
                  : json?.rangeApplied
                    ? "Duplicating the composition and setting its range…"
                    : "Duplicating the pillar composition in Descript…";
        const toastDesc =
          path === "agent"
            ? "Underlord will create a styled clip from Claude's suggested timestamps."
            : path === "precise"
              ? "Upload finishes first, then Underlord applies the layout pack."
              : path === "buffered"
                ? "60 seconds of buffer before and after Claude's suggested range. The new project will appear when the upload finishes."
                : json?.mode === "cold"
                  ? path === "full-range"
                    ? "First clip from this pillar — uploading the whole video once, so the range isn't set this time. Future clips will be trimmed instantly."
                    : "First clip from this pillar — uploading once. Future clips will be instant."
                  : json?.rangeApplied
                    ? "Trimmed to the clip's timestamps, with the full source still in the project so you can extend it."
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

  const introActive = includeIntro && wholeIntroRange != null;
  const introDuration = wholeIntroRange
    ? Math.max(0, Math.round(wholeIntroRange.endSec - wholeIntroRange.startSec))
    : 0;
  // Ordered ranges the right-side player plays back: intro (if on) then body.
  const playbackSegments = introActive
    ? [wholeIntroRange!, { startSec: idea.startSec, endSec: idea.endSec }]
    : [{ startSec: idea.startSec, endSec: idea.endSec }];

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

                {(idea.descriptAttempts ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800">
                    <span className="font-semibold">
                      Attempted: {idea.descriptAttempts}×
                    </span>
                    <span className="text-amber-700">
                      — Descript failed before. Re-promote to try again.
                    </span>
                  </div>
                )}

                <div className="space-y-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Why it&apos;ll go viral
                  </h3>
                  <p className="text-[13px] leading-relaxed text-foreground/90">
                    {idea.rationale}
                  </p>
                </div>

                {!isDecided && introSegs.length > 0 && (
                  <label className="flex items-start gap-2 cursor-pointer select-none rounded-md border border-border bg-muted/30 p-2.5">
                    <input
                      type="checkbox"
                      checked={includeIntro}
                      disabled={introSaving}
                      onChange={(e) => toggleIntro(e.target.checked)}
                      className="mt-0.5 size-4 accent-primary disabled:opacity-50"
                    />
                    <span className="text-[13px] leading-snug">
                      <span className="font-medium">Include intro at top</span>
                      <span className="block text-[11px] text-muted-foreground">
                        Prepends the whole intro of the source video ahead of the
                        clip. Requires a precise cut.
                      </span>
                    </span>
                  </label>
                )}

                {((preview && preview.segments.length > 0) || introActive) && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Transcript
                    </h3>
                    <div className="max-h-60 space-y-2 overflow-y-auto">
                      {/* Intro plays first, so it reads first in the transcript —
                          its own section directly under the header. */}
                      {introActive && (
                        <div className="rounded border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-2">
                          <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-amber-800">
                            Intro · {fmtTs(wholeIntroRange!.startSec)}–
                            {fmtTs(wholeIntroRange!.endSec)} ({introDuration}s)
                          </div>
                          <p className="mt-1 text-[12px] leading-relaxed text-amber-900">
                            {introText || "(no transcript text for the intro)"}
                          </p>
                        </div>
                      )}
                      {preview && preview.segments.length > 0 && (
                        <div className="text-[13px] leading-relaxed text-muted-foreground">
                          {preview.segments
                            .map((s) => s.text.trim())
                            .filter(Boolean)
                            .join(" ")}
                        </div>
                      )}
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

              <div className="self-center w-full">
                {idea.targetPostType === "x" ? (
                  <XPostPreview
                    body={hookDraft || idea.hook}
                    segments={playbackSegments}
                    preview={preview}
                    account={idea.targetAccount ?? null}
                  />
                ) : (
                  <ShortsPreview
                    hook={hookDraft || idea.hook}
                    segments={playbackSegments}
                    preview={preview}
                  />
                )}
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
                        {introActive && (
                          <p className="mt-1.5 text-[11px] text-amber-700 leading-snug">
                            <span className="font-medium">
                              Intro prepended.
                            </span>{" "}
                            Only the precise-cut options can stitch it in.
                          </p>
                        )}
                      </div>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("full")}
                        disabled={!packAttached || introActive}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Full Composition
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Start from the entire pillar video and edit the
                          clip manually.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("full-range")}
                        disabled={!packAttached || introActive}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Duplicate + Set Range
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Copy the pillar composition and set it to
                          Claude&apos;s timestamps. No trim, no layout pack —
                          the whole source stays available to edit by hand.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("precise")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Precise Cut + Layout Pack
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Use Claude&apos;s exact clip timestamps, then apply
                          the format layout (captions, hook, vertical). Fast,
                          but no extra footage if boundaries need adjusting.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("buffered")}
                        disabled={!packAttached}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Buffered Cut — Recommended
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Claude&apos;s suggested clip plus 60 seconds before
                          and after, so you have room to fix the beginning
                          or ending.
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void runCreateInDescript("agent")}
                        disabled={!packAttached || introActive}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <span className="font-medium">
                          Underlord Edit
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          Let Underlord turn Claude&apos;s suggested moment into
                          a styled clip using the full pillar as context.
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

/**
 * Read-only X-post simulator for the triage dialog. Renders the clip as it
 * will appear on the brand's X timeline — header (avatar + name + verified
 * + @handle), hook as the tweet body, the source video clipped to the
 * `[startSec, endSec]` range below it, and a muted reactions row beneath.
 *
 * Conceptually mirrors the full `<XSimulator>` used inside `<ContentPreview>`
 * on the content detail page, but pared down to a non-editable preview: no
 * draft-media drop zone, no CTA card, no inline editing. The triage view's
 * job is "show what this would look like as an X post" so the operator can
 * decide to promote or kill — the full editing surface lives on the detail
 * page that opens after acceptance.
 */
function XPostPreview({
  body,
  segments,
  preview,
  account,
}: {
  body: string;
  segments: { startSec: number; endSec: number }[];
  preview: Preview | null;
  account: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    platform: string;
    verified: boolean | null;
  } | null;
}) {
  const displayName =
    account?.displayName?.trim() || account?.handle || "Your account";
  const handle = account?.handle ?? "you";
  const isAudio = preview?.videoContentType?.startsWith("audio/");
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <SocialEmbedHeader
        name={displayName}
        subtitle={`@${handle} · now`}
        avatarUrl={account?.avatarUrl ?? null}
        verified={account?.verified ?? false}
        monogramSeed={{
          displayName: account?.displayName ?? null,
          handle: account?.handle ?? null,
        }}
      />
      <p className="whitespace-pre-wrap break-words text-[15px] leading-snug text-foreground">
        {body}
      </p>
      {preview?.videoUrl ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-black">
          {isAudio ? (
            <div className="flex w-full items-center justify-center py-3">
              <SegmentedMedia
                videoUrl={preview.videoUrl}
                isAudio
                segments={segments}
                className="w-full px-3"
              />
            </div>
          ) : (
            <SegmentedMedia
              videoUrl={preview.videoUrl}
              isAudio={false}
              segments={segments}
              className="block aspect-video h-auto w-full bg-black object-contain"
            />
          )}
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-2xl border border-border bg-muted text-[12px] text-muted-foreground">
          {preview === null ? "Loading preview…" : "No preview available"}
        </div>
      )}
      <div className="flex items-center justify-between pt-1 text-muted-foreground">
        <div className="flex items-center gap-1.5 text-[12px]">
          <MessageCircleIcon className="h-4 w-4" strokeWidth={1.6} />
        </div>
        <div className="flex items-center gap-1.5 text-[12px]">
          <RepeatIcon className="h-4 w-4" strokeWidth={1.6} />
        </div>
        <div className="flex items-center gap-1.5 text-[12px]">
          <HeartIcon className="h-4 w-4" strokeWidth={1.6} />
        </div>
        <div className="flex items-center gap-1.5 text-[12px]">
          <BarChart2Icon className="h-4 w-4" strokeWidth={1.6} />
        </div>
        <div className="flex items-center gap-3">
          <BookmarkIcon className="h-4 w-4" strokeWidth={1.6} />
          <UploadIcon className="h-4 w-4" strokeWidth={1.6} />
        </div>
      </div>
    </div>
  );
}

function ShortsPreview({
  hook,
  segments,
  preview,
}: {
  hook: string;
  segments: { startSec: number; endSec: number }[];
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
      className="relative mx-auto w-full max-w-[320px] rounded-xl bg-black text-white overflow-hidden flex flex-col justify-center shadow-lg"
      style={{ aspectRatio: "9 / 16" }}
    >
      {/* Mirrors the published ReelsLayout: hook + video (natural aspect,
          NEVER cropped — `object-contain` matters for split-screen podcast
          sources where `object-cover` would chop both speakers in half) +
          caption are stacked as one block and centered vertically inside
          the 9:16 frame. The black space above and below is intentional —
          that's exactly how the final Short looks. */}
      <div className="px-4 pb-3 shrink-0">
        <p className="text-[20px] font-extrabold leading-[1.15] line-clamp-3 text-center">
          {hook}
        </p>
      </div>

      <div className="w-full bg-black shrink-0">
        {preview?.videoUrl ? (
          isAudio ? (
            <div className="flex w-full items-center justify-center py-3">
              <SegmentedMedia
                videoUrl={preview.videoUrl}
                isAudio
                segments={segments}
                className="w-full px-3"
              />
            </div>
          ) : (
            <SegmentedMedia
              videoUrl={preview.videoUrl}
              isAudio={false}
              segments={segments}
              className="block h-auto w-full bg-black object-contain"
            />
          )
        ) : (
          <div
            className="flex w-full items-center justify-center text-[11px] text-white/50"
            style={{ aspectRatio: "16 / 9" }}
          >
            {preview === null ? "Loading preview…" : "No preview available"}
          </div>
        )}
      </div>

      {captionText && (
        <div className="px-4 pt-4 shrink-0 text-center">
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

/**
 * A media element that plays an ordered list of source ranges back-to-back —
 * the same intro→body sequence the precise cut will assemble. With one segment
 * it just plays that range and stops; with an intro prepended it starts at the
 * intro, then jumps to the body when the intro ends, so the preview matches the
 * final clip. A single HTML media element can't play disjoint ranges natively,
 * so we drive it: seek to the first segment on load, skip across the gap to the
 * next segment in `timeupdate`, pause at the last segment's end, and restart
 * from the top on the next Play.
 */
function SegmentedMedia({
  videoUrl,
  isAudio,
  segments,
  className,
}: {
  videoUrl: string;
  isAudio: boolean;
  segments: { startSec: number; endSec: number }[];
  className?: string;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  // Index of the segment currently playing. Advances strictly forward so the
  // sequence is correct even when ranges overlap (e.g. a clip whose body sits
  // inside the intro window). The `key` remounts the element when the segment
  // list changes, which resets this to 0.
  const idxRef = useRef(0);
  const segKey = segments.map((s) => `${s.startSec}-${s.endSec}`).join("|");

  const seekStart = () => {
    const el = ref.current;
    if (!el || segments.length === 0) return;
    idxRef.current = 0;
    try {
      el.currentTime = segments[0].startSec;
    } catch {
      // metadata not ready yet; onLoadedMetadata will fire again
    }
  };

  const onTimeUpdate = () => {
    const el = ref.current;
    if (!el || segments.length === 0) return;
    const seg = segments[idxRef.current];
    if (!seg) return;
    // Reached the end of the current segment → advance to the next, or stop
    // (leaving the last frame showing) if this was the final one.
    if (el.currentTime >= seg.endSec - 0.04) {
      const next = idxRef.current + 1;
      if (next < segments.length) {
        idxRef.current = next;
        el.currentTime = segments[next].startSec;
      } else {
        el.pause();
      }
    }
  };

  const onPlay = () => {
    const el = ref.current;
    if (!el || segments.length === 0) return;
    // Pressing Play after it finished restarts from the first segment (intro).
    const last = segments.length - 1;
    if (idxRef.current >= last && el.currentTime >= segments[last].endSec - 0.05) {
      idxRef.current = 0;
      el.currentTime = segments[0].startSec;
    }
  };

  const setRef = (el: HTMLMediaElement | null) => {
    ref.current = el;
  };

  if (isAudio) {
    return (
      <audio
        key={`${videoUrl}|${segKey}`}
        ref={setRef}
        src={videoUrl}
        controls
        preload="metadata"
        onLoadedMetadata={seekStart}
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlay}
        className={className}
      />
    );
  }
  return (
    <video
      key={`${videoUrl}|${segKey}`}
      ref={setRef}
      src={videoUrl}
      controls
      preload="metadata"
      playsInline
      onLoadedMetadata={seekStart}
      onTimeUpdate={onTimeUpdate}
      onPlay={onPlay}
      className={className}
    />
  );
}
