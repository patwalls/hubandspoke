"use client";

// The newsletter editor (flag `newsletterDrafter`), modeled on the design
// editor's full-screen dialog. Opening an undrafted slot starts the draft;
// once ready, each template section is edited on its own (with a per-section
// Regenerate + optional instruction) next to a live preview of the whole
// issue. The sponsor section shows the Asana promo controls; How-To slots can
// switch their source video. Saves are revision-checked (409 on a stale tab).
// beehiiv formats open in the visual view: the email itself is the canvas
// (click text to edit it in place, click a screenshot to pick or upload its
// image) with the selection's controls in a side panel, like the design
// editor; "Text view" is the original side-by-side layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ExternalLink, FileText, LayoutTemplate, Loader2, MousePointerClick, RefreshCw, Shuffle, Sparkles, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { composeIssue, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";
import { EmailPreview } from "@/components/dashboard/email-preview";
import { ScreenshotMarkPanel, ScreenshotPicker, useScreenshots } from "@/components/dashboard/newsletter-screenshot-picker";
import { applyScreenshots, parseScreenshotMarks } from "@/lib/newsletter-screenshots";
import type { NewsletterDraftSource, NewsletterSpecialSource } from "@/lib/db/schema";
import { NEWSLETTER_START_DELAY_MS } from "@/lib/services/newsletter-drafter/format-config";

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
  beehiivPostUrl: string | null;
  beehiivStatus: string | null;
  beehiivError: string | null;
  updatedAt: string;
  /** Per section with a story: how often this newsletter ran it before. */
  sectionUsage?: Record<string, { count: number; lastDate: string | null; label: string; published?: string | null }>;
  /** Preview links for picked screenshot frames, by placeholder key. */
  screenshotPreviews?: Record<string, string>;
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

  const busy =
    draft?.status === "drafting" || (draft?.regenerating.length ?? 0) > 0 || draft?.hubspotStatus === "pending" || draft?.beehiivStatus === "pending";
  useEffect(() => {
    if (!open || !busy) return;
    return startVisibleInterval(() => {
      void load().then((d) => {
        if (d && d.status !== "drafting" && d.regenerating.length === 0 && d.hubspotStatus !== "pending" && d.beehiivStatus !== "pending") onChanged();
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
  // How-To screenshot placeholders → frames from the video (only once there's a written draft).
  const shots = useScreenshots(draft.id, draft.kind === "single_video" && draft.status === "ready", draft.screenshotPreviews ?? {});
  const seenRevision = useRef(draft.revision);
  const seenStatus = useRef(draft.status);
  // The revision the next save is based on, and the save in flight (saves run one at a time).
  const revisionRef = useRef(draft.revision);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  // Visual view (beehiiv formats): what's selected on the canvas, and the section open for typing.
  const [view, setView] = useState<"visual" | "text">(draft.template?.beehiiv ? "visual" : "text");
  const [selected, setSelected] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);

  // Re-seed local edits when the server version moves under us (draft landed, a
  // section regenerated, the sponsor refreshed) — never on an unchanged poll.
  useEffect(() => {
    if (draft.revision === seenRevision.current && draft.status === seenStatus.current) return;
    seenRevision.current = draft.revision;
    seenStatus.current = draft.status;
    revisionRef.current = draft.revision;
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

  function save(): Promise<boolean> {
    const next = saveChain.current.then(() => saveNow());
    saveChain.current = next;
    return next;
  }

  async function saveNow(): Promise<boolean> {
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
          revision: revisionRef.current,
          ...(draft.template ? { sections } : { bodyMarkdown: body }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { draft?: EditorDraft; error?: string };
      if (!res.ok || !json.draft) throw new Error(json.error ?? "Couldn't save");
      // Our own save: don't re-seed local edits from it (you may already be typing elsewhere).
      revisionRef.current = json.draft.revision;
      seenRevision.current = json.draft.revision;
      seenStatus.current = json.draft.status;
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

  async function cancelRun(section?: string) {
    await post(`/api/newsletter-drafts/${draft.id}/cancel`, section ? { section } : {}, section ? `cancel:${section}` : "cancel");
  }

  async function special(action: "verbatim" | "rewrite" | "refresh") {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/special`, { action }, `special:${action}`);
  }

  async function redraft() {
    if (!window.confirm("Redraft the whole issue? Your edits to this draft will be replaced.")) return;
    await post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "redraft");
  }

  async function pushToBeehiiv() {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/beehiiv`, {}, "beehiiv");
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
      <div className="flex flex-wrap items-center gap-2 pr-8">
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
        {draft.status === "ready" && (
          <>
            {draft.template?.beehiiv && (
              <Button variant="ghost" size="sm" onClick={() => setView((v) => (v === "visual" ? "text" : "visual"))}>
                {view === "visual" ? <FileText /> : <LayoutTemplate />}
                {view === "visual" ? "Text view" : "Visual view"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={redraft} disabled={busyAction !== null}>
              {busyAction === "redraft" && <Loader2 className="animate-spin" />}
              Redraft
            </Button>
            <Button variant="outline" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
            {draft.template?.beehiiv ? (
              draft.beehiivPostUrl ? (
                <a href={draft.beehiivPostUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                  Open in beehiiv <ExternalLink />
                </a>
              ) : (
                <Button
                  size="sm"
                  onClick={pushToBeehiiv}
                  disabled={busyAction !== null || draft.beehiivStatus === "pending"}
                  title="Creates an unsent DRAFT post in beehiiv from Kevin's or Saj's template. Never publishes or schedules."
                >
                  {(busyAction === "beehiiv" || draft.beehiivStatus === "pending") && <Loader2 className="animate-spin" />}
                  Create beehiiv draft
                </Button>
              )
            ) : draft.hubspotEmailUrl ? (
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

  const sectionMd = (key: string) => sections.find((x) => x.key === key)?.markdown ?? "";
  const setSectionMd = (key: string, md: string) =>
    setSections((cur) => (cur.some((x) => x.key === key) ? cur.map((x) => (x.key === key ? { ...x, markdown: md } : x)) : [...cur, { key, markdown: md }]));
  const deselect = () => {
    setSelected(null);
    setEditingSection(null);
  };
  const selSection = selected && !selected.startsWith("shot:") ? (draft.template?.sections.find((s) => s.key === selected) ?? null) : null;
  const selShot = selected?.startsWith("shot:") ? selected.slice(5) : null;
  const shotMark = selShot ? (draft.template?.sections.flatMap((s) => parseScreenshotMarks(s.key, sectionMd(s.key))).find((m) => m.key === selShot) ?? null) : null;

  const subjectFields = (
    <>
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
    </>
  );

  const visual = draft.template ? (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto max-w-[640px] px-5 pt-5">
          <button
            type="button"
            onClick={deselect}
            title="Edit the subject and preview text"
            className={cn("block w-full rounded-t-lg border border-b-0 bg-background px-4 py-2 text-left hover:bg-muted/60", !selected && "ring-2 ring-[#49adff]")}
          >
            <div className="text-sm font-semibold">{subject || "(no subject)"}</div>
            <div className="text-xs text-muted-foreground">{previewText || "(no preview text)"}</div>
          </button>
        </div>
        <EmailPreview
          template={draft.template}
          sections={sections}
          sponsor={specialCopy.trim() ? { copy: specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null}
          screenshots={draft.kind === "single_video" ? { chosen: shots.chosen, urlFor: shots.urlFor } : undefined}
          edit={{
            selected,
            editingSection,
            regenerating: draft.regenerating,
            onSelectSection: (key) => {
              setSelected(key);
              if (draft.template?.sections.find((s) => s.key === key)?.kind !== "sponsor") setEditingSection(key);
            },
            onChangeSection: setSectionMd,
            onDoneEditing: () => {
              setEditingSection(null);
              if (dirty) void save();
            },
            onSelectShot: (_sectionKey, markKey) => {
              setEditingSection(null);
              setSelected(`shot:${markKey}`);
            },
            onDropShot: (_sectionKey, markKey, file) => {
              setEditingSection(null);
              setSelected(`shot:${markKey}`);
              void shots.upload(markKey, file);
            },
          }}
        />
        <p className="flex items-center justify-center gap-1.5 pb-6 text-center text-xs text-muted-foreground">
          <MousePointerClick className="size-3.5" /> Click any text to edit it · click a screenshot to pick a frame or upload one · or drop an image on it
        </p>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l p-4">
        {selected && (
          <button type="button" onClick={deselect} className="self-start text-xs text-muted-foreground hover:text-foreground">
            ← Subject &amp; preview text
          </button>
        )}
        {selSection ? (
          selSection.kind === "sponsor" ? (
            <SponsorSection
              label={draft.specialLabel ?? selSection.heading ?? "Sponsor"}
              draft={draft}
              copy={specialCopy}
              setCopy={setSpecialCopy}
              agentMarkdown={sectionMd(selSection.key)}
              setAgentMarkdown={(md) => setSectionMd(selSection.key, md)}
              busyAction={busyAction}
              onAction={special}
            />
          ) : (
            <>
              <SectionEditor
                key={selSection.key}
                label={selSection.heading ?? selSection.key.replace(/_/g, " ")}
                hint={selSection.hint}
                value={sectionMd(selSection.key)}
                onChange={(md) => setSectionMd(selSection.key, md)}
                hideText
                regenerating={draft.regenerating.includes(selSection.key)}
                disabled={busyAction !== null}
                onRegenerate={(instruction) => regenerate(selSection.key, instruction)}
                source={draft.kind === "roundup" ? (sections.find((x) => x.key === selSection.key)?.source ?? null) : null}
                usage={draft.sectionUsage?.[selSection.key] ?? null}
                onFindNewStory={draft.kind === "roundup" ? (instruction) => regenerate(selSection.key, instruction, true) : undefined}
                onCancel={() => cancelRun(selSection.key)}
              />
              <p className="text-xs text-muted-foreground">
                {editingSection === selSection.key
                  ? "Typing in the email edits this section. **bold**, [text](link) and “- ” bullets work. Click outside it to finish; it saves on its own."
                  : "Click the section in the email to edit its text."}
              </p>
            </>
          )
        ) : selShot ? (
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium">Screenshot</span>
            {shotMark ? (
              <ScreenshotMarkPanel key={shotMark.key} mark={shotMark} shots={shots} />
            ) : (
              <span className="text-xs text-muted-foreground">This placeholder is no longer in the text.</span>
            )}
            {shots.error && <span className="text-xs text-destructive">{shots.error}</span>}
          </div>
        ) : (
          <>
            {subjectFields}
            <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
              Click any part of the email to edit it. Text opens right where it is; a screenshot opens its frames, Upload and Remove here.
            </p>
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {draft.kind === "single_video" && <VideoBar draft={draft} disabled={draft.status === "drafting" || busyAction !== null} onPick={(itemId) => post(`/api/newsletter-drafts/${draft.id}/video`, { itemId }, "video")} />}
      {draft.hubspotStatus === "failed" && draft.hubspotError && (
        <p className="mx-5 mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">Email push: {draft.hubspotError}</p>
      )}
      {draft.beehiivStatus === "failed" && draft.beehiivError && (
        <p className="mx-5 mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">beehiiv push: {draft.beehiivError}</p>
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
      ) : draft.status === "idea" ? (
        <IdeaPanel draft={draft} disabled={busyAction !== null} drafting={busyAction === "draft"} onDraft={() => post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "draft")} />
      ) : draft.status === "drafting" ? (
        <DraftingPanel draft={draft} cancelling={busyAction === "cancel"} onCancel={() => cancelRun()} />
      ) : draft.status === "failed" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
          <span className="font-medium text-destructive">The draft failed</span>
          <pre className="max-w-2xl whitespace-pre-wrap text-xs text-muted-foreground">{draft.error}</pre>
          <Button onClick={() => post(`/api/newsletter-drafts/${draft.id}/draft`, {}, "retry")} disabled={busyAction !== null}>
            {busyAction === "retry" && <Loader2 className="animate-spin" />}
            Try again
          </Button>
        </div>
      ) : view === "visual" && visual ? (
        visual
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
                    onCancel={() => cancelRun(sec.key)}
                  >
                    {draft.kind === "single_video" && (
                      <ScreenshotPicker sectionKey={sec.key} markdown={sections.find((x) => x.key === sec.key)?.markdown ?? ""} shots={shots} />
                    )}
                  </SectionEditor>
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
                  sections={sections.map((x) => ({ ...x, markdown: applyScreenshots(x.key, x.markdown, shots.chosen, shots.urlFor) }))}
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A clock that ticks every second while mounted (keeps Date.now() out of render). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** An undrafted slot: nothing runs until the editor clicks Draft (one paid run). */
function IdeaPanel({ draft, disabled, drafting, onDraft }: { draft: EditorDraft; disabled: boolean; drafting: boolean; onDraft: () => void }) {
  const now = useNow();
  const daysOut = draft.sendDate ? Math.floor((Date.parse(`${draft.sendDate}T12:00:00Z`) - now) / DAY_MS) : 0;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <Sparkles className="size-6 text-pink-500" />
      <span className="font-medium text-foreground">Not drafted yet</span>
      <span className="max-w-md text-xs">
        {draft.kind === "single_video"
          ? "Drafting reads the video's transcript, writes every section of the template, then reviews its own draft."
          : "Drafting reads this week's videos and case studies, writes every section of the template, then reviews its own draft."}{" "}
        One Claude run, usually a few minutes.
      </span>
      {daysOut > 7 && (
        <span className="max-w-md rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          This issue sends {fmtDate(draft.sendDate)}, {daysOut} days from now. Most of its stories probably aren&apos;t published yet, so a
          draft now would likely need redrafting closer to the date.
        </span>
      )}
      <Button onClick={onDraft} disabled={disabled}>
        {drafting && <Loader2 className="animate-spin" />}
        Draft this issue
      </Button>
    </div>
  );
}

/** A run in progress: a free cancel window first (the job waits in the queue), then the run itself. */
function DraftingPanel({ draft, cancelling, onCancel }: { draft: EditorDraft; cancelling: boolean; onCancel: () => void }) {
  const now = useNow();
  const left = Math.ceil((Date.parse(draft.updatedAt) + NEWSLETTER_START_DELAY_MS - now) / 1000);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Sparkles className="size-6 animate-pulse text-pink-500" />
      <span className="text-sm font-medium text-foreground">{left > 0 ? `Starting in ${left}s…` : `Drafting ${draft.formatName}…`}</span>
      <span className="max-w-md text-xs">
        {left > 0
          ? "Cancel now and nothing runs (no charge)."
          : "Usually a few minutes. You can close this and come back. Cancel stops it at the end of its current step; you're only charged for the steps already done."}
      </span>
      <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
        {cancelling ? <Loader2 className="animate-spin" /> : <X />}
        Cancel
      </Button>
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
  onCancel,
  hideText = false,
  children,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (md: string) => void;
  regenerating: boolean;
  disabled: boolean;
  onRegenerate: (instruction: string) => void;
  source?: NewsletterSection["source"];
  usage?: { count: number; lastDate: string | null; label: string; published?: string | null } | null;
  onFindNewStory?: (instruction: string) => void;
  onCancel?: () => void;
  /** Visual view: the text is edited in the email itself, not here. */
  hideText?: boolean;
  /** Extra controls under the section (the How-To's screenshot picker). */
  children?: React.ReactNode;
}) {
  const [instruction, setInstruction] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize" title={hint}>
          {label}
        </span>
        {regenerating && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Regenerating…
            {onCancel && (
              <Button size="xs" variant="ghost" onClick={onCancel} title="Stop this rewrite. Free in the first few seconds; after that it stops at the end of its current step.">
                <X />
                Cancel
              </Button>
            )}
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
          {usage?.published && <span className="shrink-0 whitespace-nowrap text-muted-foreground">· {usage.published}</span>}
          <span
            className={cn(
              "shrink-0 whitespace-nowrap",
              !usage || usage.count === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
            )}
            title="Times this story has run in this newsletter (issues we have records of: HubSpot since late Aug 2026, Klaviyo before)"
          >
            · {usage?.label ?? "Never featured"}
          </span>
        </div>
      )}
      {!hideText && <Textarea className="min-h-28 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} disabled={regenerating} />}
      {children}
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
