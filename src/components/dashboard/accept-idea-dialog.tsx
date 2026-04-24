"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const REASON_MAX = 2000;
const REASON_MIN = 10;

interface AcceptIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  saving?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}

// Mirror of KillIdeaDialog for the accept path. Forces a reason (≥10 chars)
// because accepts feed the LLM's positive-example loop — a silent accept
// teaches nothing.
export function AcceptIdeaDialog({
  open,
  onOpenChange,
  title,
  saving = false,
  onConfirm,
}: AcceptIdeaDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length >= REASON_MIN && !saving;

  async function handleConfirm() {
    if (!canConfirm) return;
    await onConfirm(trimmed.slice(0, REASON_MAX));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Accept &quot;{title || "(Untitled)"}&quot;?</DialogTitle>
          <DialogDescription>
            What makes this a good cross-post? The reason trains future
            suggestions — past accepts are fed back into the classifier.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. clear evergreen lesson, no platform-specific framing, fits the LinkedIn audience…"
          rows={4}
          maxLength={REASON_MAX}
          autoFocus
          disabled={saving}
        />
        <div className="text-xs text-muted-foreground">
          {trimmed.length < REASON_MIN
            ? `${REASON_MIN - trimmed.length} more character${
                REASON_MIN - trimmed.length === 1 ? "" : "s"
              } needed`
            : `${trimmed.length}/${REASON_MAX}`}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {saving ? "Accepting…" : "Accept"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
