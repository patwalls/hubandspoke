"use client";

// Opens the newsletter editor for a queue item (post_type "newsletter"): looks
// up the item's edition, then shows the same editor the Newsletters board
// uses. Rendered only for users with the `newsletterDrafter` flag; everyone
// else gets the regular triage dialog.

import { useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NewsletterEditorDialog } from "@/components/dashboard/newsletter-editor-dialog";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || draftId) return;
    let cancelled = false;
    fetch(`/api/newsletter-drafts/for-item/${itemId}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { draftId?: string; error?: string };
        if (cancelled) return;
        if (r.ok && j.draftId) setDraftId(j.draftId);
        else setError(j.error ?? "Couldn't open this newsletter.");
      })
      .catch(() => !cancelled && setError("Couldn't open this newsletter."));
    return () => {
      cancelled = true;
    };
  }, [open, itemId, draftId]);

  if (!open) return null;
  if (draftId) return <NewsletterEditorDialog draftId={draftId} open={open} onOpenChange={onOpenChange} onChanged={onDone} />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
