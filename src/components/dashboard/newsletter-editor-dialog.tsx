"use client";

// The newsletter editor (flag `newsletterDrafter`), modeled on the design
// editor's full-screen dialog. Opening an undrafted slot starts the draft;
// once ready, each template section is edited on its own (with a per-section
// Regenerate + optional instruction) next to a live preview of the whole
// issue. The sponsor section shows the Asana promo controls; How-To slots can
// switch their source video. Saves are revision-checked (409 on a stale tab).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ExternalLink, Loader2, RefreshCw, Shuffle, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { composeIssue, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";
import { EmailPreview } from "@/components/dashboard/email-preview";
import type { NewsletterDraftSource, NewsletterSpecialSource } from "@/lib/db/schema";

export interface EditorDraft {
  id: string;
  status: "idea" | "drafting" | "ready" | "failed";
  formatName: string;
  kind: "roundup" | "single_video";
  sendDate: string | null;
  slotKey: string | null;
  subject: string | null;
  subjectOptions: string[];
  previewText: string | null;
  bodyMarkdown: string | null;
  sections: NewsletterSection[];
  template: NewsletterTemplate | null;
  revision: number;
  regenerating: string[];
  sources: NewsletterDraftSource[];
  sourceItemId: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  notes: string | null;
  model: string | null;
  error: string | null;
  specialCopy: string | null;
  specialOriginal: string | null;
  specialMode: "verbatim" | "rewrite" | null;
  specialSource: NewsletterSpecialSource | null;
  specialError: string | null;
  specialLabel: string | null;
  hubspotStatus: string | null;
  hubspotEmailUrl: string | null;
  hubspotError: string | null;
  /** Per section with a story: how often this newsletter ran it before. */
  sectionUsage?: Record<string, { count: number; lastDate: string | null; label: string }>;
}

interface VideoOption {
  id: string;
  title: string | null;
  publishedAt: string | null;
  channel: string;
  usedBySlot: string | null;
}

const POLL_MS = 4_000;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function NewsletterEditorDialog({
  draftId,
  open,
  onOpenChange,
  onChanged,
}: {
  draftId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const load = useCallback(async (): Promise<EditorDraft | null> => {
    const res = await fetch(`/api/newsletter-drafts/${draftId}`);
    if (!res.ok) {
      setLoadError("Couldn't load this newsletter.");
      return null;
    }
    const { draft: d } = (await res.json()) as { draft: EditorDraft };
    setDraft(d);
    return d;
  }, [draftId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/newsletter-drafts/${draftId}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ draft: EditorDraft }>) : null))
      .then((json) => {
        if (cancelled) return;
        if (json) setDraft(json.draft);
        else setLoadError("Couldn't load this newsletter.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, draftId]);

  // Opening an undrafted slot starts its draft (one paid run per explicit open).
  // A How-To slot with no video waits for the editor to pick one.
  const shouldStart = open && draft?.status === "idea" && !(draft.kind === "single_video" && !draft.sourceItemId);
  useEffect(() => {
    if (!shouldStart || startedRef.current) return;
    startedRef.current = true;
    void fetch(`/api/newsletter-drafts/${draftId}/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(() => load())
      .then(() => onChanged());
  }, [shouldStart, draftId, load, onChanged]);

  const busy = draft?.status === "drafting" || (draft?.regenerating.length ?? 0) > 0 || draft?.hubspotStatus === "pending";
  useEffect(() => {
    if (!open || !busy) return;
    return startVisibleInterval(() => {
      void load().then((d) => {
        if (d && d.status !== "drafting" && d.regenerating.length === 0 && d.hubspotStatus !== "pending") onChanged();
      });
    }, POLL_MS);
  }, [open, busy, load, onChanged]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1500px,97vw)]">
        <DialogTitle className="sr-only">Newsletter editor</DialogTitle>
        {!draft ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {loadError ?? <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <Workspace key={draft.id} draft={draft} setDraft={setDraft} reload={load} onChanged={onChanged} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Workspace({
  draft,
  setDraft,
  reload,
  onChanged,
}: {
  draft: EditorDraft;
  setDraft: (d: EditorDraft) => void;
  reload: () => Promise<EditorDraft | null>;
  onChanged: () => void;
}) {
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [previewText, setPreviewText] = useState(draft.previewText ?? "");
  const [sections, setSections] = useState<NewsletterSection[]>(draft.sections);
  const [body, setBody] = useState(draft.bodyMarkdown ?? "");
  const [specialCopy, setSpecialCopy] = useState(draft.specialCopy ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const seenRevision = useRef(draft.revision);
  const seenStatus = useRef(draft.status);

  // Re-seed local edits when the server version moves under us (draft landed, a
  // section regenerated, the sponsor refreshed) — never on an unchanged poll.
  useEffect(() => {
    if (draft.revision === seenRevision.current && draft.status === seenStatus.current) return;
    seenRevision.current = draft.revision;
    seenStatus.current = draft.status;
    setSubject(draft.subject ?? "");
    setPreviewText(draft.previewText ?? "");
    setSections(draft.sections);
    setBody(draft.bodyMarkdown ?? "");
    setSpecialCopy(draft.specialCopy ?? "");
  }, [draft]);

  const dirty =
    subject !== (draft.subject ?? "") ||
    previewText !== (draft.previewText ?? "") ||
    body !== (draft.bodyMarkdown ?? "") ||
    specialCopy !== (draft.specialCopy ?? "") ||
    JSON.stringify(sections) !== JSON.stringify(draft.sections);

  const preview = useMemo(() => {
    if (!draft.template) return body;
    return composeIssue(draft.template, sections, specialCopy.trim() ? { copy: specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null);
  }, [draft.template, draft.specialSource, sections, specialCopy, body]);

  async function save(): Promise<boolean> {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          previewText,
          specialCopy,
          revision: draft.revision,
          ...(draft.template ? { sections } : { bodyMarkdown: body }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { draft?: EditorDraft; error?: string };
      if (!res.ok || !json.draft) throw new Error(json.error ?? "Couldn't save");
      setDraft(json.draft);
      setMessage("Saved");
      onChanged();
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function post(path: string, bodyJson: unknown, label: string) {
    setBusyAction(label);
    setMessage(null);
    try {
      const res = await fetch(path, { method: path.endsWith("/video") ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyJson ?? {}) });
      const json = (await res.json().catch(() => ({}))) as { draft?: EditorDraft; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Something went wrong");
      if (json.draft) setDraft(json.draft);
      else await reload();
      onChanged();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function regenerate(key: string, instruction: string, newStory = false) {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/sections/${key}/regenerate`, { instruction: instruction || null, newStory }, `regen:${key}`);
  }

  async function special(action: "verbatim" | "rewrite" | "refresh") {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/special`, { action }, `special:${action}`);
  }

  async function redraft() {
    if (!window.confirm("Redraft the whole issue? Your edits to this draft will be replaced.")) return;
    await post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "redraft");
  }

  async function pushToHubspot() {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/hubspot`, {}, "hubspot");
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
      <div className="flex flex-col">
        <span className="text-base font-semibold">{draft.formatName}</span>
        <span className="text-xs text-muted-foreground">
          {draft.sendDate ? `Sends ${fmtDate(draft.sendDate)}` : "No send date"}
          {draft.model && ` · ${draft.model}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
        {draft.status === "ready" && (
          <>
            <Button variant="ghost" size="sm" onClick={redraft} disabled={busyAction !== null}>
              {busyAction === "redraft" && <Loader2 className="animate-spin" />}
              Redraft
            </Button>
            <Button variant="outline" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
            {draft.hubspotEmailUrl ? (
              <a href={draft.hubspotEmailUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                Open in HubSpot <ExternalLink />
              </a>
            ) : (
              <Button size="sm" onClick={pushToHubspot} disabled={busyAction !== null || draft.hubspotStatus === "pending"}>
                {(busyAction === "hubspot" || draft.hubspotStatus === "pending") && <Loader2 className="animate-spin" />}
                Create email draft
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {draft.kind === "single_video" && <VideoBar draft={draft} disabled={draft.status === "drafting" || busyAction !== null} onPick={(itemId) => post(`/api/newsletter-drafts/${draft.id}/video`, { itemId }, "video")} />}
      {draft.hubspotStatus === "failed" && draft.hubspotError && (
        <p className="mx-5 mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">Email push: {draft.hubspotError}</p>
      )}
      {draft.error && draft.status === "ready" && (
        <p className="mx-5 mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{draft.error}</p>
      )}

      {draft.status === "idea" && draft.kind === "single_video" && !draft.sourceItemId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">No recent video to draft from yet</span>
          <span>Pick a video above, then draft.</span>
          <Button onClick={() => post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "draft")} disabled={busyAction !== null}>
            {busyAction === "draft" && <Loader2 className="animate-spin" />}
            Draft
          </Button>
        </div>
      ) : draft.status === "idea" || draft.status === "drafting" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Sparkles className="size-6 animate-pulse text-pink-500" />
          <span className="text-sm font-medium text-foreground">Drafting {draft.formatName}…</span>
          <span className="max-w-md text-center text-xs">
            {draft.kind === "single_video"
              ? "Reading the video's transcript, writing every section of the template, then reviewing its own draft."
              : "Reading this week's videos and case studies, writing every section of the template, then reviewing its own draft."}{" "}
            Usually a few minutes. You can close this and come back.
          </span>
        </div>
      ) : draft.status === "failed" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
          <span className="font-medium text-destructive">The draft failed</span>
          <pre className="max-w-2xl whitespace-pre-wrap text-xs text-muted-foreground">{draft.error}</pre>
          <Button onClick={() => post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "retry")} disabled={busyAction !== null}>
            {busyAction === "retry" && <Loader2 className="animate-spin" />}
            Try again
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-5">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Subject</span>
              {draft.subjectOptions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {draft.subjectOptions.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setSubject(opt)}
                      className={cn("rounded-full border px-3 py-1 text-left text-xs hover:bg-muted", subject === opt && "border-primary bg-muted")}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium">Preview text</span>
              <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
            </label>

            {draft.template ? (
              draft.template.sections.map((sec) =>
                sec.kind === "sponsor" ? (
                  <SponsorSection
                    key={sec.key}
                    label={draft.specialLabel ?? sec.heading ?? "Sponsor"}
                    draft={draft}
                    copy={specialCopy}
                    setCopy={setSpecialCopy}
                    agentMarkdown={sections.find((x) => x.key === sec.key)?.markdown ?? ""}
                    setAgentMarkdown={(md) => setSections((cur) => cur.map((x) => (x.key === sec.key ? { ...x, markdown: md } : x)))}
                    busyAction={busyAction}
                    onAction={special}
                  />
                ) : (
                  <SectionEditor
                    key={sec.key}
                    label={sec.heading ?? sec.key.replace(/_/g, " ")}
                    hint={sec.hint}
                    value={sections.find((x) => x.key === sec.key)?.markdown ?? ""}
                    onChange={(md) =>
                      setSections((cur) => (cur.some((x) => x.key === sec.key) ? cur.map((x) => (x.key === sec.key ? { ...x, markdown: md } : x)) : [...cur, { key: sec.key, markdown: md }]))
                    }
                    regenerating={draft.regenerating.includes(sec.key)}
                    disabled={busyAction !== null}
                    onRegenerate={(instruction) => regenerate(sec.key, instruction)}
                    source={draft.kind === "roundup" ? (sections.find((x) => x.key === sec.key)?.source ?? null) : null}
                    usage={draft.sectionUsage?.[sec.key] ?? null}
                    onFindNewStory={draft.kind === "roundup" ? (instruction) => regenerate(sec.key, instruction, true) : undefined}
                  />
                ),
              )
            ) : (
              <label className="flex flex-col gap-2 text-sm">
                <span className="font-medium">Body (Markdown)</span>
                <Textarea className="min-h-[480px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
            )}

            {draft.sources.length > 0 && draft.kind === "roundup" && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Sources used</span>
                {draft.sources.map((s, i) => (
                  <span key={i} className="text-xs text-muted-foreground">
                    <span className="mr-2 rounded bg-muted px-1.5 py-0.5">{s.kind === "video" ? "Video" : "Case study"}</span>
                    {s.url ? (
                      <a className="text-primary underline" href={s.url} target="_blank" rel="noreferrer">
                        {s.title ?? s.url}
                      </a>
                    ) : (
                      (s.title ?? "Untitled")
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto bg-muted/40">
            {draft.template ? (
              <>
                <div className="mx-auto max-w-[640px] px-5 pt-5">
                  <div className="rounded-t-lg border border-b-0 bg-background px-4 py-2">
                    <div className="text-sm font-semibold">{subject || "(no subject)"}</div>
                    <div className="text-xs text-muted-foreground">{previewText}</div>
                  </div>
                </div>
                <EmailPreview
                  template={draft.template}
                  sections={sections}
                  sponsor={specialCopy.trim() ? { copy: specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null}
                  />
              </>
            ) : (
              <div className="mx-auto max-w-[640px] p-5">
                <div className="rounded-lg border bg-background p-6 text-sm leading-relaxed shadow-sm">
                  <ReactMarkdown>{preview}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionEditor({
  label,
  hint,
  value,
  onChange,
  regenerating,
  disabled,
  onRegenerate,
  source,
  usage,
  onFindNewStory,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (md: string) => void;
  regenerating: boolean;
  disabled: boolean;
  onRegenerate: (instruction: string) => void;
  source?: NewsletterSection["source"];
  usage?: { count: number; lastDate: string | null; label: string } | null;
  onFindNewStory?: (instruction: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize" title={hint}>
          {label}
        </span>
        {regenerating && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Regenerating…
          </span>
        )}
      </div>
      {source && (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{source.kind === "video" ? "Video" : "Case study"}</span>
          {source.url ? (
            <a className="truncate text-primary underline" href={source.url} target="_blank" rel="noreferrer" title={source.title ?? source.url}>
              {source.title ?? source.url}
            </a>
          ) : (
            <span className="truncate">{source.title ?? source.key}</span>
          )}
          <span
            className={cn(
              "shrink-0 whitespace-nowrap",
              !usage || usage.count === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
            )}
          >
            · {usage?.label ?? "New"}
          </span>
        </div>
      )}
      <Textarea className="min-h-28 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} disabled={regenerating} />
      <div className="flex items-center gap-2">
        <Input
          className="h-7 text-xs"
          placeholder="Optional: how to change it (e.g. 'shorter', 'lead with the $50K')"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={regenerating}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onRegenerate(instruction);
            setInstruction("");
          }}
          disabled={disabled || regenerating}
        >
          <RefreshCw />
          Regenerate
        </Button>
        {onFindNewStory && source && (
          <Button
            size="sm"
            variant="outline"
            title="Swap to a different video or case study this newsletter hasn't run recently"
            onClick={() => {
              onFindNewStory(instruction);
              setInstruction("");
            }}
            disabled={disabled || regenerating}
          >
            <Shuffle />
            Find new story
          </Button>
        )}
      </div>
    </div>
  );
}

function SponsorSection({
  label,
  draft,
  copy,
  setCopy,
  agentMarkdown,
  setAgentMarkdown,
  busyAction,
  onAction,
}: {
  label: string;
  draft: EditorDraft;
  copy: string;
  setCopy: (s: string) => void;
  agentMarkdown: string;
  setAgentMarkdown: (s: string) => void;
  busyAction: string | null;
  onAction: (a: "verbatim" | "rewrite" | "refresh") => void;
}) {
  const fromAsana = !!draft.specialSource;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 dark:border-amber-700/50 dark:bg-amber-900/10">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{label} (sponsor)</span>
          {draft.specialSource ? (
            <a className="text-xs text-primary underline" href={draft.specialSource.taskUrl} target="_blank" rel="noreferrer">
              {draft.specialSource.taskName}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">No sponsor from Asana{draft.specialError ? `: ${draft.specialError}` : ""} — the draft wrote this section.</span>
          )}
          {draft.specialSource?.copyFrom === "focus_field" && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              Placeholder: using the task&apos;s &quot;ad copy focus&quot;. Add a &quot;Final Newsletter Copy&quot; subtask in Asana for the real copy.
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {fromAsana && (
            <>
              <Button size="sm" variant={draft.specialMode === "verbatim" ? "secondary" : "outline"} onClick={() => onAction("verbatim")} disabled={busyAction !== null}>
                {busyAction === "special:verbatim" && <Loader2 className="animate-spin" />}
                Use as written
              </Button>
              <Button size="sm" variant={draft.specialMode === "rewrite" ? "secondary" : "outline"} onClick={() => onAction("rewrite")} disabled={busyAction !== null}>
                {busyAction === "special:rewrite" && <Loader2 className="animate-spin" />}
                {draft.specialMode === "rewrite" ? "Rewrite again" : "Rewrite in our voice"}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => onAction("refresh")} disabled={busyAction !== null}>
            {busyAction === "special:refresh" && <Loader2 className="animate-spin" />}
            Refresh from Asana
          </Button>
        </div>
      </div>
      {fromAsana ? (
        <Textarea className="min-h-28 text-xs" value={copy} onChange={(e) => setCopy(e.target.value)} />
      ) : (
        <Textarea className="min-h-28 font-mono text-xs" value={agentMarkdown} onChange={(e) => setAgentMarkdown(e.target.value)} />
      )}
      {draft.specialSource?.landingUrl && <span className="break-all text-xs text-muted-foreground">Landing page: {draft.specialSource.landingUrl}</span>}
    </div>
  );
}

function VideoBar({ draft, disabled, onPick }: { draft: EditorDraft; disabled: boolean; onPick: (itemId: string) => void }) {
  const [videos, setVideos] = useState<VideoOption[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/newsletter-drafts/${draft.id}/video`)
      .then((r) => (r.ok ? r.json() : { videos: [] }))
      .then((j: { videos: VideoOption[] }) => !cancelled && setVideos(j.videos));
    return () => {
      cancelled = true;
    };
  }, [draft.id]);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2 text-sm">
      <span className="font-medium">Source video</span>
      <select
        className="h-8 max-w-xl rounded-lg border border-input bg-background px-2 text-sm"
        value={draft.sourceItemId ?? ""}
        disabled={disabled || !videos}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      >
        {!draft.sourceItemId && <option value="">Pick a video…</option>}
        {draft.sourceItemId && !videos?.some((v) => v.id === draft.sourceItemId) && <option value={draft.sourceItemId}>{draft.sourceTitle ?? "Current video"}</option>}
        {videos?.map((v) => (
          <option key={v.id} value={v.id}>
            {fmtDate(v.publishedAt)} · {v.channel} · {v.title ?? "Untitled"}
            {v.usedBySlot ? ` (used ${v.usedBySlot.split(":")[1]})` : ""}
          </option>
        ))}
      </select>
      {draft.sourceUrl && (
        <a className="text-xs text-primary underline" href={draft.sourceUrl} target="_blank" rel="noreferrer">
          Watch
        </a>
      )}
      {draft.status === "ready" && <span className="text-xs text-muted-foreground">Switching the video doesn&apos;t redraft — click Redraft after.</span>}
    </div>
  );
}
