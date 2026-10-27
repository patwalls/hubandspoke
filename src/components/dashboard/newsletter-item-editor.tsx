"use client";

// Opens the newsletter editor for a queue item (post_type "newsletter"): looks
// up the item's edition, then shows the same editor the Newsletters board
// uses. An undrafted edition (`idea`) first gets the New-newsletter dialog,
// prefilled with its format and send date, so the editor picks the pillar
// video and angle instead of the drafter choosing its own stories. Rendered
// only for users with the `newsletterDrafter` flag; everyone else gets the
// regular triage dialog.

import { useEffect, useRef, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NewsletterEditorDialog } from "@/components/dashboard/newsletter-editor-dialog";
import { refreshNewsletterDraftBadges } from "@/components/dashboard/newsletter-draft-badge";
import { NewNewsletterDialog, type NewsletterSlot } from "@/components/dashboard/new-content-menu";

/** Window event fired when the editor closes (detail: { itemId }), so the content page's email preview re-renders. */
export const NEWSLETTER_EDITOR_CLOSED = "newsletter-editor-closed";

export function NewsletterItemEditor({
  itemId,
  open,
  onOpenChange,
  onDone,
}: {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [draftId, setDraftId] = useState<string | null>(null);
  /** Undrafted: ask for the pillar + angle before the editor opens. Cleared once the draft starts. */
  const [slot, setSlot] = useState<NewsletterSlot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hold the caller's refresh until the editor closes: creating the email
  // draft moves the item out of the queue (→ Ready To Publish), and refreshing
  // mid-edit would drop its row (and this editor with it). Refresh once, on
  // close, if anything changed — the queue's Draft badges too.
  const changed = useRef(false);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) window.dispatchEvent(new CustomEvent(NEWSLETTER_EDITOR_CLOSED, { detail: { itemId } }));
    if (!o && changed.current) {
      changed.current = false;
      refreshNewsletterDraftBadges();
      onDone();
    }
  };

  useEffect(() => {
    if (!open || draftId) return;
    let cancelled = false;
    fetch(`/api/newsletter-drafts/for-item/${itemId}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as {
          draftId?: string;
          edition?: Omit<NewsletterSlot, "draftId"> & { status: string; sourcePinned: boolean };
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok || !j.draftId) return setError(j.error ?? "Couldn't open this newsletter.");
        const e = j.edition;
        if (e?.status === "idea")
          setSlot({
            draftId: j.draftId,
            brand: e.brand,
            formatId: e.formatId,
            sendDate: e.sendDate,
            // Only a video someone chose; never a sweep's suggestion.
            sourceItemId: e.sourcePinned ? e.sourceItemId : null,
            notes: e.notes,
          });
        setDraftId(j.draftId);
      })
      .catch(() => !cancelled && setError("Couldn't open this newsletter."));
    return () => {
      cancelled = true;
    };
  }, [open, itemId, draftId]);

  if (!open) return null;
  if (slot)
    return (
      <NewNewsletterDialog
        brands={[]}
        initialBrand={slot.brand}
        slot={slot}
        onClose={() => close(false)}
        onStarted={() => {
          changed.current = true;
          setSlot(null);
        }}
      />
    );
  if (draftId)
    return (
      <NewsletterEditorDialog
        draftId={draftId}
        open={open}
        onOpenChange={close}
        onChanged={() => {
          changed.current = true;
        }}
      />
    );
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="text-sm font-medium">Newsletter</DialogTitle>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Opening…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Content-page entry to the newsletter editor for a newsletter item (flagged). Renders nothing otherwise. */
export function NewsletterEditorLauncher({
  item,
  onDone,
}: {
  item: { id: string; postType: string | null };
  onDone: () => void;
}) {
  const flags = useFeatureFlags();
  const [open, setOpen] = useState(false);
  if (item.postType !== "newsletter" || !flags?.newsletterDrafter) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <Mail className="size-3" aria-hidden />
        Open newsletter editor
      </button>
      <NewsletterItemEditor itemId={item.id} open={open} onOpenChange={setOpen} onDone={onDone} />
    </>
  );
}
