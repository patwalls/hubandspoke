"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trackUsage } from "@/lib/usage/track";
import { sendBackCommentHtml, type RowAction } from "@/lib/my-work/actions";
import { firstName } from "@/lib/handoff/pick";
import { useCanEditBrand } from "@/components/brand-access";

const VIEW_ONLY_TITLE = "View only — you don't have edit access to this brand";

/**
 * The buttons on a My Work row (rules in src/lib/my-work/actions.ts). Moves
 * the item through the same PUT the content page uses, so status_change
 * events and notifications are unchanged. "Send back" asks for an optional
 * note first and posts it as a comment on the item.
 *
 * An action with `handTo` also makes that person the editor (the content
 * page's one-click handoff), and says so on the button: "Approve → John".
 *
 * Each button carries `data-row-key` so MyWorkKeys can fire it from the
 * keyboard on the focused row.
 */
export function RowActions({
  id,
  brand,
  title,
  actions,
}: {
  id: string;
  brand: string;
  title: string;
  actions: RowAction[];
}) {
  const router = useRouter();
  const canEdit = useCanEditBrand(brand);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (noting) noteRef.current?.focus();
  }, [noting]);

  async function run(action: RowAction, noteText = "") {
    if (!canEdit) return;
    setBusy(true);
    trackUsage(`my-work:${action.kind}`, brand);
    try {
      const comment = action.kind === "send-back" ? sendBackCommentHtml(noteText) : null;
      if (comment) {
        const c = await fetch(`/api/production-items/${id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: comment }),
        });
        if (!c.ok) throw new Error((await c.json().catch(() => ({}))).error || "Couldn't save the note");
      }
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action.handTo
            ? { id, status: action.to, editorUserId: action.handTo.id }
            : { id, status: action.to },
        ),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't move it");
      const to = action.handTo ? `${action.to} · ${firstName(action.handTo.name)}` : action.to;
      setNoting(false);
      setDone(to);
      toast.success(`“${title}” → ${to}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't move it");
    } finally {
      setBusy(false);
    }
  }

  if (actions.length === 0) return null;
  if (done) {
    return <span className="text-[11px] text-muted-foreground whitespace-nowrap">→ {done}</span>;
  }

  if (noting) {
    const sendBack = actions.find((a) => a.kind === "send-back")!;
    return (
      <form
        className="flex items-center gap-1.5 justify-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run(sendBack, note);
        }}
      >
        <input
          ref={noteRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setNoting(false);
          }}
          placeholder="What needs fixing? (optional)"
          aria-label="Note for the editor"
          className="h-7 w-56 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          disabled={busy}
        />
        <Button type="submit" size="xs" variant="outline" disabled={busy}>
          {sendBack.handTo ? `Send back → ${firstName(sendBack.handTo.name)}` : "Send back"}
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setNoting(false)}>
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1.5 justify-end">
      {actions.map((a) => (
        <Button
          key={a.kind}
          size="xs"
          variant={a.kind === "send-back" ? "outline" : "default"}
          disabled={busy || !canEdit}
          data-row-key={a.key}
          title={
            !canEdit
              ? VIEW_ONLY_TITLE
              : a.handTo
              ? `${a.label}: moves it to ${a.to} and makes ${a.handTo.name} the editor (${a.key})`
              : `${a.label} (${a.key})`
          }
          onClick={() => (a.kind === "send-back" ? setNoting(true) : void run(a))}
        >
          {a.label}
          {a.handTo && <span className="ml-1 opacity-80">→ {firstName(a.handTo.name)}</span>}
          <kbd className="ml-1 font-mono text-[10px] opacity-60">{a.key}</kbd>
        </Button>
      ))}
    </div>
  );
}
