"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KillIdeaDialog } from "./kill-idea-dialog";

interface ClipIdeaSummary {
  id: string;
  hook: string;
  angle: string;
  rationale: string;
  startSec: number;
  endSec: number;
  estimatedViews: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea: ClipIdeaSummary | null;
  onDone: () => void;
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function fmtViews(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K views`;
  return `${n.toLocaleString()} views`;
}

export function ClipTriageDialog({
  open,
  onOpenChange,
  idea,
  onDone,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

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
    [idea, onDone, onOpenChange]
  );

  if (!idea) return null;
  const duration = Math.max(0, Math.round(idea.endSec - idea.startSec));
  const views = fmtViews(idea.estimatedViews);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Clip idea</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4">
            <div className="rounded-md border border-border bg-background p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {fmtTs(idea.startSec)}–{fmtTs(idea.endSec)} ({duration}s)
                </span>
                {views && (
                  <span className="text-foreground font-medium">~{views}</span>
                )}
              </div>
              <p className="text-sm font-medium leading-snug">
                “{idea.hook}”
              </p>
              <p className="text-[13px] leading-snug">
                <span className="text-muted-foreground">Angle: </span>
                {idea.angle}
              </p>
              <p className="text-[12px] text-muted-foreground leading-snug">
                <span className="font-medium text-foreground/80">Why: </span>
                {idea.rationale}
              </p>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center justify-between border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setKillOpen(true)}
                disabled={saving}
                className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Kill idea
              </button>
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
