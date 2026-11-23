"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { trackUsage } from "@/lib/usage/track";
import type { LatestAutoClose } from "@/lib/services/idea-auto-close";

/**
 * One quiet line atop the queue's History tab after the weekly auto-close
 * (services/idea-auto-close.ts): "Mon Nov 30: 1,234 clip ideas nobody touched
 * in 60 days closed themselves · Undo". Undo brings back the ones still
 * closed. Hidden when the brand has no run in the last 30 days.
 */
export function AutoCloseNotice({ brand, onUndone }: { brand: string; onUndone: () => void }) {
  const [latest, setLatest] = useState<LatestAutoClose | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/queue/auto-close?brand=${encodeURIComponent(brand)}`);
      if (!res.ok) return;
      const json = (await res.json()) as { latest: LatestAutoClose | null };
      setLatest(json.latest);
    } catch {
      /* the line is optional */
    }
  }, [brand]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!latest || latest.closed === 0) return null;

  async function undo() {
    if (!latest) return;
    setSaving(true);
    trackUsage("queue:auto-close:undo", brand);
    try {
      const res = await fetch("/api/queue/auto-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, run: latest.run }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const n = Number(json.restored ?? 0);
      toast.success(`Brought back ${n.toLocaleString()} idea${n === 1 ? "" : "s"}`, { duration: 4000 });
      await load();
      onUndone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't undo");
    } finally {
      setSaving(false);
    }
  }

  const day = new Date(`${latest.run}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const n = latest.closed;
  return (
    <p data-testid="auto-close-notice" className="mb-3 text-xs text-muted-foreground">
      {day}: {n.toLocaleString()} clip idea{n === 1 ? "" : "s"} nobody touched in 60 days closed
      {n === 1 ? " itself" : " themselves"}
      {latest.undoable > 0 ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={() => void undo()}
            disabled={saving}
            className="underline underline-offset-2 hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            {saving ? "Bringing back…" : latest.undoable === n ? "Undo" : `Undo (${latest.undoable.toLocaleString()} still closed)`}
          </button>
        </>
      ) : (
        " · all brought back or moved since"
      )}
    </p>
  );
}
