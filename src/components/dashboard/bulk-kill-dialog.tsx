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

interface BulkKillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  saving?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}

export function BulkKillDialog({
  open,
  onOpenChange,
  count,
  saving = false,
  onConfirm,
}: BulkKillDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length >= REASON_MIN && !saving && count > 0;

  async function handleConfirm() {
    if (!canConfirm) return;
    await onConfirm(trimmed.slice(0, REASON_MAX));
  }

  const noun = count === 1 ? "idea" : "ideas";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kill {count} {noun}?</DialogTitle>
          <DialogDescription>
            One reason will be applied to all {count} selected {noun}. Kill
            reasons train future idea suggestions — past kills are fed back
            into the classifier.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. weird automation flooded the queue, off-brand, duplicates…"
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
            {saving ? `Killing ${count}…` : `Kill ${count} ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
