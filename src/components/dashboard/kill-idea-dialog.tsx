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

interface KillIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  saving?: boolean;
  onConfirm: (reason: string | null) => void | Promise<void>;
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

  async function handleConfirm() {
    const trimmed = reason.trim();
    await onConfirm(trimmed ? trimmed.slice(0, REASON_MAX) : null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kill "{title || "(Untitled)"}"?</DialogTitle>
          <DialogDescription>
            Optional: why wouldn't this work? Capturing the reason helps improve
            future ideas.
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
            disabled={saving}
          >
            {saving ? "Killing…" : "Kill idea"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
