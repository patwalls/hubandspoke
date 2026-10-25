"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";
import { validatePublishedLinkPlatform } from "@/lib/published-link-validation";

// The one and only path to status='Published' / status='Scheduled'. The
// generic PUT /api/production-items route rejects those status values
// directly so editors can't half-publish (status flipped, link missing).
//
// Two modes:
//   - "Publish" tab: required URL + optional date. Sets status, link,
//     date, and (first time only) publishedAt.
//   - "Schedule" tab: placeholder — flips status to Scheduled, no other
//     fields. Real scheduling lands later.
//
// Edits-after-publish: when this opens on an already-Published item,
// `initialLink` and `initialPublishedDate` pre-fill the form so a typo'd
// link can be corrected without going to the DB. Save button label flips
// to "Save changes" instead of "Publish".

type Mode = "publish" | "schedule";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  /** If the item is already published, pass the current values so the
   *  Publish tab opens pre-filled and the button reads "Save changes". */
  initialLink?: string | null;
  initialPublishedDate?: string | null;
  /** If the item is already scheduled, pass its expected go-live time (ISO
   *  string) so the Schedule tab opens pre-filled. */
  initialExpectedPublishAt?: string | null;
  /** Whether the item was scheduled without a publish date (no-date mode). */
  initialNoDate?: boolean;
  /** Current status string ("Ready To Publish" / "Published" / etc.) —
   *  drives default tab + button label. */
  currentStatus?: string | null;
  /** The item's post type: a link from another platform is caught before
   *  Publish, same as the Publish screen's rows. */
  postType?: string | null;
  /** Fires after a successful save so the parent can refetch. */
  onSuccess?: () => void;
  /** Other posts from the same video waiting in Ready To Publish: the
   *  dialog offers the Publish tab, where they all take a paste + Enter. */
  publishTab?: { href: string; others: number } | null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Convert a stored UTC ISO string to the `YYYY-MM-DDTHH:mm` shape a
 *  <input type="datetime-local"> expects, in the viewer's local time. */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function PublishScheduleDialog({
  open,
  onOpenChange,
  itemId,
  initialLink,
  initialPublishedDate,
  initialExpectedPublishAt,
  initialNoDate,
  currentStatus,
  postType,
  onSuccess,
  publishTab,
}: Props) {
  const isAlreadyScheduled = currentStatus === "Scheduled";
  const isAlreadyPublished = currentStatus === "Published";

  const [mode, setMode] = useState<Mode>(
    isAlreadyScheduled ? "schedule" : "publish",
  );
  const [link, setLink] = useState<string>(initialLink ?? "");
  const [publishedDate, setPublishedDate] = useState<string>(
    initialPublishedDate ?? todayIsoDate(),
  );
  const [expectedPublishAt, setExpectedPublishAt] = useState<string>(
    isoToLocalInput(initialExpectedPublishAt),
  );
  const [noDate, setNoDate] = useState<boolean>(initialNoDate ?? false);
  const [submitting, setSubmitting] = useState(false);

  // Reset form state every time the dialog opens. Without this an edit
  // session on item A leaks its values into a subsequent edit on item B.
  useEffect(() => {
    if (!open) return;
    setMode(isAlreadyScheduled ? "schedule" : "publish");
    setLink(initialLink ?? "");
    setPublishedDate(initialPublishedDate ?? todayIsoDate());
    setExpectedPublishAt(isoToLocalInput(initialExpectedPublishAt));
    setNoDate(initialNoDate ?? false);
    setSubmitting(false);
  }, [
    open,
    isAlreadyScheduled,
    initialLink,
    initialPublishedDate,
    initialExpectedPublishAt,
    initialNoDate,
  ]);

  const linkValid = useMemo(() => {
    const t = link.trim();
    if (!t) return false;
    try {
      new URL(t);
      return true;
    } catch {
      return false;
    }
  }, [link]);

  const mismatch = linkValid
    ? validatePublishedLinkPlatform(link.trim(), postType)
    : null;

  const saveDisabled =
    submitting || (mode === "publish" && (!linkValid || !!mismatch));

  async function handleSave() {
    if (saveDisabled) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = { mode };
      if (mode === "publish") {
        payload.link = link.trim();
        if (publishedDate) payload.publishedDate = publishedDate;
      } else {
        payload.noDate = noDate;
        if (!noDate) {
          // Send the expected go-live time as a full UTC ISO string (the
          // datetime-local value is in the viewer's local zone). Empty string
          // explicitly clears any previously-set time.
          const t = expectedPublishAt.trim();
          payload.expectedPublishAt = t ? new Date(t).toISOString() : "";
        }
      }
      const res = await fetch(
        `/api/production-items/${itemId}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't save publish info");
        return;
      }
      toast.success(
        mode === "publish"
          ? isAlreadyPublished
            ? "Publish info updated"
            : "Published"
          : noDate
            ? "Scheduled (no date yet)"
            : "Scheduled",
      );
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save publish info",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const saveLabel = (() => {
    if (submitting) return "Saving…";
    if (mode === "schedule") {
      return isAlreadyScheduled ? "Save changes" : "Schedule";
    }
    if (isAlreadyPublished) return "Save changes";
    return "Publish";
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {isAlreadyPublished ? "Edit publish info" : "Publish or Schedule"}
          </DialogTitle>
        </DialogHeader>

        {/* Mode tabs. Hidden when editing an already-published or
         *  already-scheduled item because mode is forced — switching to
         *  the other tab in that state would be unintuitive (Scheduled
         *  → Publish would need a link the user may not have yet). */}
        {!isAlreadyPublished && (
          <div className="flex w-full rounded-md border border-border bg-muted/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode("publish")}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 font-medium transition-colors",
                mode === "publish"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Publish now
            </button>
            <button
              type="button"
              onClick={() => setMode("schedule")}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 font-medium transition-colors",
                mode === "schedule"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Schedule
            </button>
          </div>
        )}

        {mode === "publish" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="publish-link">Published link</Label>
              <Input
                id="publish-link"
                type="url"
                placeholder="https://x.com/…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                autoFocus
                aria-invalid={!!mismatch}
              />
              {mismatch ? (
                <p
                  className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"
                  data-testid="publish-link-mismatch"
                >
                  <AlertTriangle className="size-3 shrink-0" />
                  {mismatch}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  The live URL of the post. Required — pasting an invalid
                  URL keeps Save disabled.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="publish-date">Published date</Label>
              <Input
                id="publish-date"
                type="date"
                value={publishedDate}
                onChange={(e) => setPublishedDate(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Defaults to today. Same-day sort order is broken by the
                separate `publishedAt` timestamp the server stamps once.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                id="no-date"
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-foreground"
                checked={noDate}
                onChange={(e) => {
                  setNoDate(e.target.checked);
                  if (e.target.checked) setExpectedPublishAt("");
                }}
              />
              <Label htmlFor="no-date" className="cursor-pointer font-normal">
                No publish date yet
              </Label>
            </div>
            {!noDate && (
              <div className="space-y-1.5">
                <Label htmlFor="expected-publish-at">
                  Expected go-live{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="expected-publish-at"
                  type="datetime-local"
                  value={expectedPublishAt}
                  onChange={(e) => setExpectedPublishAt(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  When you expect this to actually post (your native scheduler /
                  post-scheduler time). We auto-detect the live post within ~10
                  min of go-live and tie it back to this item — a closer time
                  makes the match more accurate. Leave blank if unsure.
                </p>
              </div>
            )}
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              {noDate ? (
                <>
                  Saving flags this post as{" "}
                  <span className="font-medium text-foreground">Scheduled (No Date Yet)</span>.
                  We check hourly for up to 14 days and auto-flip it to Published
                  once the video goes live.
                </>
              ) : (
                <>
                  Saving flags this post as{" "}
                  <span className="font-medium text-foreground">Scheduled</span> and
                  stops it appearing in Ready-To-Publish queues. Once it goes live,
                  it auto-flips to Published with the real link and metrics.
                </>
              )}
            </div>
          </div>
        )}

        {mode === "publish" && !isAlreadyPublished && publishTab && publishTab.others > 0 && (
          <p
            data-testid="publish-dialog-publish-tab"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          >
            {publishTab.others === 1
              ? "1 more post from this video is ready to publish. "
              : `${publishTab.others} more posts from this video are ready to publish. `}
            <Link
              href={publishTab.href}
              onClick={() => trackUsage("publish:way-in:dialog")}
              className="font-medium text-foreground underline underline-offset-2"
            >
              Paste all their links on the Publish tab
            </Link>
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saveDisabled}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
