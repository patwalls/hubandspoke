"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserCombobox } from "./user-combobox";
import { trackUsage } from "@/lib/usage/track";
import { inBatches } from "@/lib/my-work/bulk";
import { ASSIGN_ALL_TO } from "@/lib/derivatives/assign-all";
import { useCanEditBrand } from "@/components/brand-access";

// The Derivatives tab, right after a format spawns its posts: pick one editor
// and move every post still at Idea to Assigned in one go, instead of opening
// each one to set the editor and the status. Same PUT as the content page's
// editor + status chips (one call per post carries both), so events and the
// assignment notification are unchanged. Which rows: src/lib/derivatives/assign-all.ts.

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export function DerivativesAssignAll({
  brand,
  ids,
  users,
  onDone,
}: {
  brand: string;
  ids: string[];
  users: AssignableUser[];
  onDone: () => void;
}) {
  const [editorUserId, setEditorUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = useCanEditBrand(brand);
  const n = ids.length;

  async function assign() {
    if (!editorUserId || n === 0) return;
    setBusy(true);
    trackUsage("derivatives:assign-all", brand);
    try {
      const { ok, failed, firstError } = await inBatches(ids, 5, async (id) => {
        const res = await fetch("/api/production-items", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, editorUserId, status: ASSIGN_ALL_TO }),
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        }
      });
      const who = users.find((u) => u.id === editorUserId);
      const name = who?.name?.trim() || who?.email.split("@")[0] || "them";
      const posts = (k: number) => `${k} post${k === 1 ? "" : "s"}`;
      if (failed === 0) toast.success(`Assigned ${posts(ok)} to ${name}`);
      else if (ok === 0) toast.error(`Couldn't assign ${posts(failed)}: ${firstError}`);
      else toast.warning(`Assigned ${posts(ok)} to ${name}; ${failed} failed: ${firstError}`, { duration: 8000 });
      setEditorUserId("");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  // Bulk-assign is purely an edit action — nothing to show view-only users.
  if (n === 0 || !canEdit) return null;

  return (
    <div
      data-testid="derivatives-assign-all"
      className="px-4 sm:px-5 py-2.5 border-b border-border bg-muted/40 flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-muted-foreground">
        {n} ideas not assigned yet. Give them all to
      </span>
      <UserCombobox
        value={editorUserId}
        onValueChange={setEditorUserId}
        users={users}
        disabled={busy}
        chipSize="xs"
        triggerClassName="h-7 rounded-md border border-input bg-background px-2 text-xs w-auto min-w-36"
        placeholder="Pick an editor…"
      />
      <Button size="sm" className="h-7" disabled={!editorUserId || busy} onClick={() => void assign()}>
        {busy ? "Assigning…" : `Assign ${n}`}
      </Button>
    </div>
  );
}
