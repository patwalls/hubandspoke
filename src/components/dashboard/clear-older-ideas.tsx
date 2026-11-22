"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BulkKillDialog } from "./bulk-kill-dialog";
import { trackUsage } from "@/lib/usage/track";
import { QUEUE_AGE_DAYS } from "@/lib/queue-age";

/**
 * "Kill all older ideas…" — one quiet link under the queue's Older view
 * (flag `queueClearOlder`). Asks the server how many rows the clear would
 * touch (brand + format, older than 30 days), shows that number in the
 * usual kill-reason dialog, then kills them in one server-side pass.
 * See src/lib/queue-clear-older.ts.
 */
export function ClearOlderIdeas({
  brand,
  format,
  onDone,
}: {
  brand: string;
  /** null = every format. */
  format: string | null;
  onDone: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/queue/clear-older", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, format, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json as { count?: number; killed?: number };
  }

  async function open() {
    setChecking(true);
    trackUsage("queue:clear-older:open", brand);
    try {
      const { count: n = 0 } = await post({ dryRun: true });
      if (n === 0) toast.info(`No ideas older than ${QUEUE_AGE_DAYS} days to clear`);
      else setCount(n);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't count older ideas");
    } finally {
      setChecking(false);
    }
  }

  async function confirm(reason: string) {
    setSaving(true);
    try {
      const { killed = 0 } = await post({ reason });
      trackUsage("queue:clear-older:done", brand);
      toast.success(`Killed ${killed.toLocaleString()} older idea${killed === 1 ? "" : "s"}`, { duration: 4000 });
      setCount(null);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't clear older ideas");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        disabled={checking}
        className="underline underline-offset-2 hover:text-foreground cursor-pointer disabled:opacity-50"
      >
        {checking ? "Counting…" : format ? `Kill all older ${format} ideas…` : "Kill all older ideas…"}
      </button>
      <BulkKillDialog
        open={count !== null}
        onOpenChange={(o) => {
          if (!o && !saving) setCount(null);
        }}
        count={count ?? 0}
        saving={saving}
        onConfirm={confirm}
        noun="older idea"
        scope={format ? `${format}` : "of this brand's"}
      />
    </>
  );
}
