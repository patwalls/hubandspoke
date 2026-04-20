"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserChip } from "./user-chip";
import type { ProductionItem } from "@/types";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface PillarRef {
  id: string;
  title: string | null;
  format: string | null;
}

interface ItemDetail {
  item: ProductionItem & { notionId?: string | null };
  pillar: PillarRef | null;
  formats: { id: string; name: string; instructions: string | null }[];
}

interface TriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
}

export function TriageDialog({
  open,
  onOpenChange,
  item,
  brand,
  users,
  onDone,
}: TriageDialogProps) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch detail + summary when the dialog opens. Detail first, summary in
  // parallel — summary hits the LLM (~1–2s) and the user can read the rest
  // of the modal while it resolves.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setSummary(null);
    setSummaryLoading(true);
    setSummaryError(null);
    setActionError(null);

    (async () => {
      try {
        const res = await fetch(`/api/production-items/${item.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ItemDetail;
        if (!cancelled) setDetail(json);
      } catch (err) {
        console.error("Triage detail fetch failed:", err);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch(`/api/production-items/${item.id}/summary`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { summary: string | null };
        if (!cancelled) setSummary(json.summary);
      } catch (err) {
        if (!cancelled)
          setSummaryError(
            err instanceof Error ? err.message : "Summary failed"
          );
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, item.id]);

  async function assignTo(userId: string) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          editorUserId: userId,
          status: "Assigned",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to assign");
    } finally {
      setSaving(false);
    }
  }

  async function killIt() {
    if (!confirm(`Kill "${item.title || "(Untitled)"}"?`)) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: "Killed" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to kill");
    } finally {
      setSaving(false);
    }
  }

  const pillar = detail?.pillar;
  const formatInstructions =
    detail && item.format
      ? detail.formats.find((f) => f.name === item.format)?.instructions ?? null
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto gap-5">
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            {(item.platform || []).map((p) => (
              <span
                key={p}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
              >
                {p}
              </span>
            ))}
            {item.format && (
              <span className="text-xs text-muted-foreground">
                · {item.format}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold pr-8">
            {item.title || "(Untitled)"}
          </DialogTitle>
        </DialogHeader>

        {/* Pillar content */}
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Pillar content
          </h3>
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pillar ? (
            <Link
              href={`/${brand}/content/${pillar.id}`}
              target="_blank"
              className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary hover:underline"
            >
              {pillar.title || "(Untitled)"}
              {pillar.format && (
                <span className="text-xs text-muted-foreground">
                  · {pillar.format}
                </span>
              )}
              <ExternalLinkIcon className="size-3 text-muted-foreground" />
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">No pillar linked.</p>
          )}
        </section>

        {/* AI summary */}
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h3>
          {summaryLoading ? (
            <p className="text-sm text-muted-foreground">Generating…</p>
          ) : summaryError ? (
            <p className="text-sm text-red-600">Couldn&apos;t generate a summary.</p>
          ) : summary ? (
            <p className="text-sm text-foreground leading-relaxed bg-accent/30 rounded-md p-3">
              {summary}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">(empty)</p>
          )}
        </section>

        {/* Format instructions */}
        {formatInstructions && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Format skill
            </h3>
            <div className="whitespace-pre-wrap break-words text-xs text-foreground bg-accent/30 rounded-md p-3 max-h-60 overflow-auto leading-relaxed">
              {formatInstructions}
            </div>
          </section>
        )}

        {/* Actions */}
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Assign editor
          </h3>
          <div className="max-h-48 overflow-y-auto grid grid-cols-2 gap-1">
            {users.length === 0 ? (
              <div className="text-xs text-muted-foreground col-span-2">
                No assignable users found.
              </div>
            ) : (
              users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => assignTo(u.id)}
                  disabled={saving}
                  className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  <UserChip user={u} size="xs" />
                </button>
              ))
            )}
          </div>

          {actionError && (
            <p className="text-[11px] text-red-600">{actionError}</p>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={killIt}
              disabled={saving}
              className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              Kill this idea
            </button>
            <Link
              href={`/${brand}/content/${item.id}`}
              target="_blank"
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Open full page
              <ExternalLinkIcon className="size-3" />
            </Link>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
