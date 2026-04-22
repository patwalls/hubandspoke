"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { UserChip, personDisplay } from "./user-chip";

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea: ClipIdeaSummary | null;
  onDone: () => void;
  brand: string;
}

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
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
  brand,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const [users, setUsers] = useState<AssignableUser[]>([]);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = (await res.json()) as { users: AssignableUser[] };
        if (!cancelled) setUsers(json.users ?? []);
      } catch {
        // Swallow — grid will render empty-state copy below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleAssign = useCallback(
    async (user: AssignableUser) => {
      if (!idea) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/clip-ideas/${idea.id}/triage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "assign", editorUserId: user.id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json?.error || `Failed (${res.status})`);
          return;
        }
        const newId: string | undefined = json?.newProductionItemId;
        const brandSlug: string = json?.sourceBrand ?? brand;
        const viewUrl = newId ? `/${brandSlug}/content/${newId}` : null;
        toast.success(`Assigned to ${personDisplay(user).name}`, {
          duration: 6000,
          action: viewUrl
            ? {
                label: "View content →",
                onClick: () => window.open(viewUrl, "_blank", "noopener"),
              }
            : undefined,
        });
        onDone();
        onOpenChange(false);
      } finally {
        setSaving(false);
      }
    },
    [idea, onDone, onOpenChange, brand],
  );

  if (!idea) return null;
  const duration = Math.max(0, Math.round(idea.endSec - idea.startSec));
  const views = fmtViews(idea.estimatedViews);
  const isDecided = idea.status && idea.status !== "suggested";

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

            {isDecided ? (
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
            ) : (
              <section className="space-y-2 border-t border-border pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Assign to
                </h3>
                <div className="max-h-56 overflow-y-auto grid grid-cols-2 gap-1">
                  {users.length === 0 ? (
                    <div className="text-xs text-muted-foreground col-span-full">
                      No assignable users found.
                    </div>
                  ) : (
                    users.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => handleAssign(u)}
                        disabled={saving}
                        className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                      >
                        <UserChip user={u} size="xs" />
                      </button>
                    ))
                  )}
                </div>
              </section>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center justify-between border-t border-border pt-3">
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
