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

interface KillIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  saving?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}

export function KillIdeaDialog({
  open,
  onOpenChange,
  title,
  saving = false,
  onConfirm,
}: KillIdeaDialogProps) {
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
          <DialogTitle>Kill "{title || "(Untitled)"}"?</DialogTitle>
          <DialogDescription>
            Why wouldn't this work? The reason trains future idea suggestions —
            past kills are fed back into the classifier.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. already covered this angle, no clear hook, off-brand…"
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
            variant="destructive"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {saving ? "Killing…" : "Kill idea"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
