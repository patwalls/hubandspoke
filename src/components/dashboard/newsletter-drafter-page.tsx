"use client";

// Newsletters board (feature flag `newsletterDrafter`): the next 2 weeks of
// scheduled issues as cards (Sunday Breakfast Sun, Daily Seinfeld Tue/Thu,
// Futurepedia How-To Tue — created by the slots sweep), plus recent drafts.
// Clicking a card opens the newsletter editor, which drafts the issue into
// the format's template on first open. Like the queue, but kept on its own
// tab (and out of production_items) while the pilot is being tuned.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import type { NewsletterSpecialSource } from "@/lib/db/schema";
import { NewsletterEditorDialog } from "./newsletter-editor-dialog";

interface BoardRow {
  id: string;
  status: "idea" | "drafting" | "ready" | "failed";
  slotKey: string | null;
  sendDate: string | null;
  subject: string | null;
  formatId: string;
  formatName: string;
  sourceItemId: string | null;
  sourceTitle: string | null;
  specialSource: NewsletterSpecialSource | null;
  specialError: string | null;
  hubspotStatus: string | null;
  updatedAt: string;
}

interface FormatOption {
  id: string;
  name: string;
  hasSkill: boolean;
  kind: "roundup" | "single_video";
}

const POLL_MS = 8_000;

function fmtDate(iso: string | null): string {
  if (!iso) return "No date";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const STATUS_LABEL: Record<BoardRow["status"], string> = { idea: "Not drafted", drafting: "Drafting", ready: "Ready", failed: "Failed" };

function StatusChip({ row }: { row: BoardRow }) {
  const inEmail = row.hubspotStatus === "created";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        inEmail && "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
        !inEmail && row.status === "ready" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
        !inEmail && row.status === "drafting" && "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
        !inEmail && row.status === "failed" && "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
        !inEmail && row.status === "idea" && "bg-muted text-muted-foreground",
      )}
    >
      {row.status === "drafting" && <Loader2 className="size-3 animate-spin" />}
      {inEmail ? "In email tool" : STATUS_LABEL[row.status]}
    </span>
  );
}

function SponsorBadge({ row }: { row: BoardRow }) {
  if (row.specialSource) {
    return (
      <span className="text-xs text-emerald-700 dark:text-emerald-300" title={row.specialSource.taskName}>
        Sponsor booked{row.specialSource.copyFrom === "focus_field" ? " (copy pending)" : ""}
      </span>
    );
  }
  if (row.specialError?.startsWith("No ")) return <span className="text-xs text-amber-700 dark:text-amber-300">No sponsor booked</span>;
  return null;
}

function SlotCard({ row, onOpen }: { row: BoardRow; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full flex-col gap-1.5 rounded-lg border bg-background p-3 text-left text-sm hover:border-primary hover:bg-muted/40">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{row.formatName}</span>
        <StatusChip row={row} />
      </div>
      {row.subject && <span className="line-clamp-2 text-muted-foreground">{row.subject}</span>}
      {row.sourceTitle && <span className="line-clamp-1 text-xs text-muted-foreground">Video: {row.sourceTitle}</span>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{fmtDate(row.sendDate)}</span>
        <SponsorBadge row={row} />
      </div>
    </button>
  );
}

export function NewsletterDrafterPage({ brand }: { brand: string }) {
  const [upcoming, setUpcoming] = useState<BoardRow[] | null>(null);
  const [past, setPast] = useState<BoardRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/newsletter-slots?brand=${encodeURIComponent(brand)}`);
    if (!res.ok) return;
    const json = (await res.json()) as { upcoming: BoardRow[]; past: BoardRow[] };
    setUpcoming(json.upcoming);
    setPast(json.past);
  }, [brand]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyDrafting = [...(upcoming ?? []), ...past].some((r) => r.status === "drafting");
  useEffect(() => {
    if (!anyDrafting || openId) return;
    return startVisibleInterval(() => void load(), POLL_MS);
  }, [anyDrafting, openId, load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/newsletter-slots/refresh?brand=${encodeURIComponent(brand)}`, { method: "POST" });
      if (res.ok) {
        const json = (await res.json()) as { upcoming: BoardRow[]; past: BoardRow[] };
        setUpcoming(json.upcoming);
        setPast(json.past);
      }
    } finally {
      setRefreshing(false);
    }
  }

  // Group upcoming slots by send date.
  const byDate = new Map<string, BoardRow[]>();
  for (const r of upcoming ?? []) {
    const k = r.sendDate ?? "";
    byDate.set(k, [...(byDate.get(k) ?? []), r]);
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Newsletters</h1>
          <p className="text-sm text-muted-foreground">
            The next two weeks of scheduled issues. Open one to draft it into its template, edit or regenerate any section, then
            send it on to the email tool.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh sponsors
        </Button>
      </div>

      {upcoming === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : upcoming.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No scheduled newsletters for this brand.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...byDate.entries()].map(([date, rows]) => (
            <div key={date} className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{fmtDate(date)}</span>
              {rows.map((r) => (
                <SlotCard key={r.id} row={r} onOpen={() => setOpenId(r.id)} />
              ))}
            </div>
          ))}
        </div>
      )}

      <OneOffDraft brand={brand} onCreated={(id) => { void load(); setOpenId(id); }} />

      {past.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Past & one-off drafts</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((r) => (
              <SlotCard key={r.id} row={r} onOpen={() => setOpenId(r.id)} />
            ))}
          </div>
        </div>
      )}

      {openId && (
        <NewsletterEditorDialog
          draftId={openId}
          open={!!openId}
          onOpenChange={(o) => !o && setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

/** A draft outside the schedule (formats without slots, or an extra issue). Roundup formats only. */
function OneOffDraft({ brand, onCreated }: { brand: string; onCreated: (id: string) => void }) {
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [formatId, setFormatId] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/newsletter-drafts?brand=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : { formats: [] }))
      .then((j: { formats: FormatOption[] }) => {
        const roundups = j.formats.filter((f) => f.kind === "roundup");
        setFormats(roundups);
        setFormatId(roundups.find((f) => f.hasSkill)?.id ?? roundups[0]?.id ?? "");
      });
  }, [brand]);

  if (formats.length === 0) return null;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/newsletter-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formatId, sendDate: sendDate || null }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !json.id) throw new Error(json.error ?? "Couldn't start the draft");
      onCreated(json.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">One-off draft</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Format</span>
          <select className="h-8 min-w-56 rounded-lg border border-input bg-background px-2 text-sm" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.hasSkill ? "" : " (no Skill yet)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Send date (optional)</span>
          <Input type="date" className="w-40" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
        </label>
        <Button size="sm" onClick={create} disabled={!formatId || creating}>
          {creating && <Loader2 className="animate-spin" />}
          Draft
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </details>
  );
}
