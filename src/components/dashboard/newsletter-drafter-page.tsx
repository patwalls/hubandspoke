"use client";

// Newsletter drafter (feature flag `newsletterDrafter`). Pick a newsletter
// format → "Draft newsletter" enqueues the agent run; the draft list polls
// while anything is drafting. The detail pane edits subject / preview / body
// (Markdown, with a rendered preview) and pushes the draft to HubSpot portal
// 53 as an unsent email.

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import type { NewsletterDraftSource } from "@/lib/db/schema";

interface FormatOption {
  id: string;
  name: string;
  hasSkill: boolean;
}

interface DraftSummary {
  id: string;
  formatId: string;
  formatName: string;
  status: "drafting" | "ready" | "failed";
  subject: string | null;
  windowStart: string;
  windowEnd: string;
  hubspotStatus: string | null;
  createdAt: string;
}

interface DraftDetail extends DraftSummary {
  sources: NewsletterDraftSource[];
  subjectOptions: string[];
  previewText: string | null;
  bodyMarkdown: string | null;
  model: string | null;
  error: string | null;
  hubspotEmailId: string | null;
  hubspotEmailUrl: string | null;
  hubspotError: string | null;
  notes: string | null;
}

const POLL_MS = 5_000;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StatusChip({ status }: { status: DraftSummary["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        status === "ready" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
        status === "drafting" && "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
        status === "failed" && "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
      )}
    >
      {status === "drafting" && <Loader2 className="size-3 animate-spin" />}
      {status}
    </span>
  );
}

export function NewsletterDrafterPage({ brand }: { brand: string }) {
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [formatId, setFormatId] = useState<string>("");
  const [days, setDays] = useState<number>(7);
  const [notes, setNotes] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/newsletter-drafts?brand=${encodeURIComponent(brand)}`);
    if (!res.ok) return;
    const json = (await res.json()) as { formats: FormatOption[]; drafts: DraftSummary[] };
    setFormats(json.formats);
    setDrafts(json.drafts);
    setFormatId((cur) => cur || (json.formats.find((f) => f.hasSkill) ?? json.formats[0])?.id || "");
  }, [brand]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const anyDrafting = drafts.some((d) => d.status === "drafting");
  useEffect(() => {
    if (!anyDrafting) return;
    return startVisibleInterval(() => void loadList(), POLL_MS);
  }, [anyDrafting, loadList]);

  async function startDraft() {
    if (!formatId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/newsletter-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formatId, days, notes: notes.trim() || null }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't start the draft");
      const { id } = (await res.json()) as { id: string };
      setSelectedId(id);
      setNotes("");
      await loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const selectedFormat = formats.find((f) => f.id === formatId);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Newsletters</h1>
        <p className="text-sm text-muted-foreground">
          Draft an issue from recently published videos and starterstory.com case studies, review it here, then create it
          as a draft email in HubSpot.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Format</span>
          <select
            className="h-8 min-w-56 rounded-lg border border-input bg-background px-2 text-sm"
            value={formatId}
            onChange={(e) => setFormatId(e.target.value)}
          >
            {formats.length === 0 && <option value="">No newsletter formats</option>}
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.hasSkill ? "" : " (no Skill yet)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Look back (days)</span>
          <Input
            type="number"
            min={1}
            max={31}
            className="w-24"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 7)}
          />
        </label>
        <label className="flex min-w-72 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Notes for this issue (optional)</span>
          <Input
            placeholder="e.g. Pitch the iOS Bootcamp, enrollment closes Friday"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <Button onClick={startDraft} disabled={!formatId || creating}>
          {creating && <Loader2 className="animate-spin" />}
          Draft newsletter
        </Button>
        {selectedFormat && !selectedFormat.hasSkill && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            This format has no Skill yet, so the draft will lean on past issues only.
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Drafts</h2>
          {drafts.length === 0 && <p className="text-sm text-muted-foreground">No drafts yet.</p>}
          {drafts.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setSelectedId(d.id)}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left text-sm hover:bg-muted",
                selectedId === d.id && "border-primary bg-muted",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{d.formatName}</span>
                <StatusChip status={d.status} />
              </div>
              <span className="line-clamp-2 text-muted-foreground">{d.subject ?? "Drafting…"}</span>
              <span className="text-xs text-muted-foreground">
                {fmtDate(d.windowStart)} – {fmtDate(d.windowEnd)} · created {fmtDate(d.createdAt)}
                {d.hubspotStatus === "created" && " · in HubSpot"}
              </span>
            </button>
          ))}
        </div>

        {selectedId ? (
          <DraftPane key={selectedId} id={selectedId} onChanged={loadList} />
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Select a draft, or start a new one.
          </div>
        )}
      </div>
    </div>
  );
}

function DraftPane({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [subject, setSubject] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/newsletter-drafts/${id}`);
    if (!res.ok) return null;
    const { draft: d } = (await res.json()) as { draft: DraftDetail };
    setDraft((prev) => {
      // Seed the editors on first load and when the draft lands (drafting →
      // ready) — never on a HubSpot-status poll, which would wipe typing.
      if (!prev || prev.status !== d.status) {
        setSubject(d.subject ?? "");
        setPreviewText(d.previewText ?? "");
        setBody(d.bodyMarkdown ?? "");
      }
      return d;
    });
    return d;
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = draft?.status === "drafting" || draft?.hubspotStatus === "pending";
  useEffect(() => {
    if (!waiting) return;
    return startVisibleInterval(() => {
      void load().then((d) => {
        if (d && d.status !== "drafting" && d.hubspotStatus !== "pending") void onChanged();
      });
    }, POLL_MS);
  }, [waiting, load, onChanged]);

  const dirty = useMemo(
    () =>
      !!draft &&
      (subject !== (draft.subject ?? "") || previewText !== (draft.previewText ?? "") || body !== (draft.bodyMarkdown ?? "")),
    [draft, subject, previewText, body],
  );

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, previewText, bodyMarkdown: body }),
      });
      if (!res.ok) throw new Error("Couldn't save");
      const { draft: d } = (await res.json()) as { draft: DraftDetail };
      setDraft(d);
      setMessage("Saved");
      await onChanged();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function pushToHubspot() {
    if (dirty) await save();
    setPushing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${id}/hubspot`, { method: "POST" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't start");
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setPushing(false);
    }
  }

  if (!draft) {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (draft.status === "drafting") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border p-6 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <Loader2 className="size-4 animate-spin" /> Drafting {draft.formatName}…
        </div>
        <p className="text-muted-foreground">
          Claude is reading this window&apos;s videos and case studies, writing the issue, then reviewing its own draft. This
          usually takes a few minutes. You can leave this page.
        </p>
      </div>
    );
  }

  if (draft.status === "failed") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-6 text-sm">
        <span className="font-medium text-destructive">The draft failed</span>
        <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{draft.error}</pre>
        <p className="text-muted-foreground">Start a new draft to try again.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {draft.formatName} · {fmtDate(draft.windowStart)} – {fmtDate(draft.windowEnd)}
          {draft.model && ` · ${draft.model}`}
          {draft.notes && <div className="mt-1 text-xs">Notes: {draft.notes}</div>}
        </div>
        <div className="flex items-center gap-2">
          {message && <span className="text-xs text-muted-foreground">{message}</span>}
          <Button variant="outline" size="sm" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
          {draft.hubspotEmailUrl ? (
            <a
              href={draft.hubspotEmailUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              Open in HubSpot <ExternalLink />
            </a>
          ) : (
            <Button size="sm" onClick={pushToHubspot} disabled={pushing || draft.hubspotStatus === "pending"}>
              {(pushing || draft.hubspotStatus === "pending") && <Loader2 className="animate-spin" />}
              Create HubSpot draft
            </Button>
          )}
        </div>
      </div>
      {draft.hubspotStatus === "failed" && draft.hubspotError && (
        <p className="rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
          HubSpot: {draft.hubspotError}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Subject</span>
        {draft.subjectOptions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {draft.subjectOptions.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSubject(opt)}
                className={cn(
                  "rounded-full border px-3 py-1 text-left text-xs hover:bg-muted",
                  subject === opt && "border-primary bg-muted",
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>

      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">
          Preview text <span className="font-normal text-muted-foreground">(set this in HubSpot after creating the draft)</span>
        </span>
        <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      </label>

      <div className="grid gap-4 xl:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Body (Markdown)</span>
          <Textarea className="min-h-[520px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Preview</span>
          <div className="newsletter-preview min-h-[520px] overflow-auto rounded-lg border bg-background p-4 text-sm leading-relaxed">
            <ReactMarkdown
              components={{
                h1: (p) => <h1 className="mb-3 mt-4 text-xl font-semibold" {...p} />,
                h2: (p) => <h2 className="mb-2 mt-4 text-lg font-semibold" {...p} />,
                h3: (p) => <h3 className="mb-2 mt-3 font-semibold" {...p} />,
                p: (p) => <p className="mb-3" {...p} />,
                ul: (p) => <ul className="mb-3 list-disc pl-5" {...p} />,
                ol: (p) => <ol className="mb-3 list-decimal pl-5" {...p} />,
                a: (p) => <a className="text-primary underline" target="_blank" rel="noreferrer" {...p} />,
                blockquote: (p) => <blockquote className="mb-3 border-l-2 pl-3 text-muted-foreground" {...p} />,
                hr: () => <hr className="my-4" />,
              }}
            >
              {body}
            </ReactMarkdown>
          </div>
        </div>
      </div>

      {draft.sources.length > 0 && (
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Sources used</span>
          <ul className="flex flex-col gap-1">
            {draft.sources.map((s, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{s.kind === "video" ? "Video" : "Case study"}</span>
                {s.url ? (
                  <a className="text-primary underline" href={s.url} target="_blank" rel="noreferrer">
                    {s.title ?? s.url}
                  </a>
                ) : (
                  (s.title ?? "Untitled")
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
