"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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

type Status =
  | "open"
  | "in_progress"
  | "needs_decision"
  | "done"
  | "wont_fix";

const ACTIONS: Array<{ status: Status; label: string; className: string }> = [
  {
    status: "open",
    label: "Reopen",
    className: "border-gray-300 text-gray-700 hover:bg-gray-50",
  },
  {
    status: "in_progress",
    label: "Start",
    className: "border-blue-300 text-blue-700 hover:bg-blue-50",
  },
  {
    status: "needs_decision",
    label: "Park",
    className: "border-purple-300 text-purple-700 hover:bg-purple-50",
  },
  {
    status: "done",
    label: "Done",
    className: "border-green-300 text-green-700 hover:bg-green-50",
  },
  {
    status: "wont_fix",
    label: "Won't fix",
    className: "border-red-300 text-red-700 hover:bg-red-50",
  },
];

export function FixRowActions({
  fixId,
  currentStatus,
  returnStatus,
}: {
  fixId: string;
  currentStatus: Status;
  returnStatus: Status;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Status | null>(null);
  const [resolveOpen, setResolveOpen] = useState<Status | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  async function patch(status: Status, resolutionNote?: string) {
    setPending(status);
    try {
      const res = await fetch(`/api/fixes/${fixId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolutionNote }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed");
      }
      toast.success(`Fix → ${status.replace(/_/g, " ")}`);
      // Stay on the same tab the user was viewing.
      router.replace(`/fixes?status=${returnStatus}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setPending(null);
    }
  }

  function handleClick(status: Status) {
    // For terminal statuses prompt for a resolution note (matches the
    // starter-story playbook — don't lose context on done / wont_fix /
    // needs_decision rows).
    if (status === "done" || status === "wont_fix" || status === "needs_decision") {
      setResolutionNote("");
      setResolveOpen(status);
      return;
    }
    void patch(status);
  }

  async function confirmResolve() {
    if (!resolveOpen) return;
    const target = resolveOpen;
    setResolveOpen(null);
    await patch(target, resolutionNote.trim() || undefined);
  }

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap gap-2">
        {ACTIONS.filter((a) => a.status !== currentStatus).map((a) => (
          <button
            key={a.status}
            type="button"
            disabled={pending !== null}
            onClick={() => handleClick(a.status)}
            className={
              "rounded border bg-card px-2.5 py-1 text-xs font-medium disabled:opacity-50 " +
              a.className
            }
          >
            {pending === a.status ? "…" : a.label}
          </button>
        ))}
      </div>

      <Dialog
        open={resolveOpen !== null}
        onOpenChange={(o) => !o && setResolveOpen(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {resolveOpen === "done"
                ? "Mark as done"
                : resolveOpen === "wont_fix"
                  ? "Won't fix"
                  : "Needs decision"}
            </DialogTitle>
            <DialogDescription>
              {resolveOpen === "done"
                ? "What shipped? One short line — shows up under the fix."
                : resolveOpen === "wont_fix"
                  ? "Why not? Saves the reasoning so it doesn't get re-filed."
                  : "Brainstorm or recommendation. Stops the fix from blocking the queue."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            rows={4}
            autoFocus
            placeholder={
              resolveOpen === "done"
                ? "e.g. Added cross-post rule for shorts → linkedin in src/lib/services/cross-post-rules.ts"
                : ""
            }
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResolveOpen(null)}
              disabled={pending !== null}
            >
              Cancel
            </Button>
            <Button onClick={confirmResolve} disabled={pending !== null}>
              {pending !== null ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
