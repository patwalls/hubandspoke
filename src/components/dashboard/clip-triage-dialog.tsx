"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UserChip } from "./user-chip";
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

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface FormatOption {
  id: string;
  name: string;
  parentFormatId: string | null;
  channels: string[] | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea: ClipIdeaSummary | null;
  pillarFormat: string | null;
  brand: string;
  onDone: () => void;
}

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];

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
  pillarFormat,
  brand,
  onDone,
}: Props) {
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [targetFormatName, setTargetFormatName] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    (async () => {
      const [uRes, fRes] = await Promise.all([
        fetch("/api/users/assignable"),
        fetch(`/api/formats?brand=${brand}`),
      ]);
      if (uRes.ok) {
        const j = (await uRes.json()) as { users: AssignableUser[] };
        setUsers(j.users);
      }
      if (fRes.ok) {
        const f = (await fRes.json()) as FormatOption[];
        setFormats(f);
      }
    })();
  }, [open, brand]);

  // Derive two groups: direct children of the pillar's format first, then
  // all other short-form formats in the brand. A format counts as short-form
  // if any of its channels is in SHORT_FORM_PLATFORMS.
  const { childrenOfPillar, otherShortForm } = useMemo(() => {
    if (formats.length === 0) {
      return { childrenOfPillar: [] as FormatOption[], otherShortForm: [] as FormatOption[] };
    }
    const pillarRow = pillarFormat
      ? formats.find((f) => f.name.toLowerCase() === pillarFormat.toLowerCase())
      : null;
    const children = pillarRow
      ? formats.filter((f) => f.parentFormatId === pillarRow.id)
      : [];
    const isShort = (f: FormatOption) =>
      (f.channels ?? []).some((c) => SHORT_FORM_PLATFORMS.includes(c));
    const childIds = new Set(children.map((c) => c.id));
    const other = formats
      .filter((f) => isShort(f) && !childIds.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { childrenOfPillar: children, otherShortForm: other };
  }, [formats, pillarFormat]);

  useEffect(() => {
    if (!open) return;
    if (targetFormatName) return;
    const first = childrenOfPillar[0] ?? otherShortForm[0];
    if (first) setTargetFormatName(first.name);
  }, [open, childrenOfPillar, otherShortForm, targetFormatName]);

  useEffect(() => {
    if (!open) {
      setTargetFormatName("");
      setError(null);
    }
  }, [open]);

  const handleAssign = useCallback(
    async (editorUserId: string) => {
      if (!idea || !targetFormatName || saving) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/clip-ideas/${idea.id}/triage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "accept",
            targetFormatName,
            editorUserId,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json?.error || `Failed (${res.status})`);
          return;
        }
        onDone();
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setSaving(false);
      }
    },
    [idea, targetFormatName, saving, onDone, onOpenChange]
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
            <DialogTitle>Triage clip idea</DialogTitle>
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

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Target format
              </label>
              <select
                value={targetFormatName}
                onChange={(e) => setTargetFormatName(e.target.value)}
                disabled={saving}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {childrenOfPillar.length > 0 && (
                  <optgroup label={`From ${pillarFormat ?? "pillar"}`}>
                    {childrenOfPillar.map((f) => (
                      <option key={f.id} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherShortForm.length > 0 && (
                  <optgroup label="Other short-form">
                    {otherShortForm.map((f) => (
                      <option key={f.id} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Assign to
              </label>
              <div className="max-h-48 overflow-y-auto grid grid-cols-2 gap-1">
                {users.length === 0 ? (
                  <div className="text-xs text-muted-foreground col-span-full">
                    No assignable users found.
                  </div>
                ) : (
                  users.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => handleAssign(u.id)}
                      disabled={saving || !targetFormatName}
                      className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      <UserChip user={u} size="xs" />
                    </button>
                  ))
                )}
              </div>
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
