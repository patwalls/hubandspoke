"use client";

// The newsletter editor (flag `newsletterDrafter`), modeled on the design
// editor's full-screen dialog. Opening an undrafted slot starts the draft;
// once ready, each template section is edited on its own (with a per-section
// Regenerate + optional instruction) next to a live preview of the whole
// issue. The sponsor section shows the Asana promo controls; How-To slots can
// switch their source video. Saves are revision-checked (409 on a stale tab).
// Templated newsletters open in the visual view: the email itself is the canvas
// (click text to edit it in place, click a screenshot to pick or upload its
// image) with the selection's controls in a side panel, like the design
// editor; "Text view" is the original side-by-side layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { AlertTriangle, Check, CheckCircle2, RotateCcw, CircleAlert, Eye, ExternalLink, History, LayoutTemplate, Lightbulb, ListChecks, Loader2, Mail, Monitor, MoreHorizontal, MousePointerClick, RefreshCw, Smartphone, SpellCheck, Sparkles, Wand2, X } from "lucide-react";
import { beehiivPreviewUrlFromEditUrl } from "@/lib/beehiiv-links";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { composeIssue, variableNames, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";
import { EmailPreview, FOOTER_NOTE, MOBILE_WIDTH } from "@/components/dashboard/email-preview";
import { EMAIL_WIDTH, renderEmailHtml } from "@/lib/newsletter-email-html";
import { formatShortcut, useInlineFormat } from "@/components/dashboard/editable-section";
import { TemplateEditorDialog } from "@/components/dashboard/newsletter-template-section";
import { StoryCard, type StoryPick } from "@/components/dashboard/story-card";
import { layoutFor, layoutText, replaceAtPath } from "@/lib/newsletter-layout";
import type { DocNode } from "@/lib/newsletter-rich-doc";
import { ImagePanel, ScreenshotMarkPanel, ScreenshotPicker, useScreenshots } from "@/components/dashboard/newsletter-screenshot-picker";
import { isVideoThumbnail } from "@/components/dashboard/preview-screenshots";
import { formatTimestamp, insertStepScreenshot, parseScreenshotMarks, removeScreenshotMark, screenshotKey, stepsWithoutScreenshots, type ScreenshotMark } from "@/lib/newsletter-screenshots";
import type { PreSendCheck } from "@/lib/services/newsletter-drafter/checks";
import { applyFixes, type ProofreadFix } from "@/lib/services/newsletter-drafter/proofread";
import type { NewsletterDraftProgress, NewsletterDraftSource, NewsletterReview, NewsletterReviewFinding, NewsletterSpecialSource } from "@/lib/db/schema";
import { NEWSLETTER_START_DELAY_MS } from "@/lib/services/newsletter-drafter/format-config";
import { DRAFT_PHASES, draftProgress, type DraftPhaseName } from "@/lib/estimated-progress";

export interface EditorDraft {
  id: string;
  formatId?: string;
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
  /** This issue's own design (designed parts edited in the draft); null = the template's. */
  layout?: Record<string, unknown> | null;
  /** The issue's values for the template's `{fields}` (the tool's name, what a card is called…). */
  variables?: Record<string, string> | null;
  /** The editor's AI review (POST …/review), when asked for. */
  review?: NewsletterReview | null;
  /** A running draft's phase (written by the worker each turn). */
  progress?: NewsletterDraftProgress | null;
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
/** Autosave this long after the last edit. */
const AUTOSAVE_MS = 1200;

/** Same sections, field by field (the server's copy comes back with its fields in another order). */
function sameSections(a: NewsletterSection[], b: NewsletterSection[]): boolean {
  const src = (v: NewsletterSection["source"]) => (v ? [v.kind, v.key, v.title, v.url, v.publishedAt ?? null] : null);
  const norm = (x: NewsletterSection) => JSON.stringify([x.key, x.markdown, src(x.source), x.tried ?? []]);
  return a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));
}

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

  // Closing (clicking out, Esc, ×, "Save draft & close") saves unsaved edits first; a failed save keeps it open.
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const requestOpenChange = (o: boolean) => {
    if (o) return onOpenChange(true);
    void flushRef.current().then((ok) => ok && onOpenChange(false));
  };

  const busy =
    draft?.status === "drafting" ||
    (draft?.regenerating.length ?? 0) > 0 ||
    draft?.hubspotStatus === "pending" ||
    draft?.beehiivStatus === "pending" ||
    draft?.review?.status === "running";
  useEffect(() => {
    if (!open || !busy) return;
    return startVisibleInterval(() => {
      void load().then((d) => {
        if (d && d.status !== "drafting" && d.regenerating.length === 0 && d.hubspotStatus !== "pending" && d.beehiivStatus !== "pending" && d.review?.status !== "running") onChanged();
      });
    }, POLL_MS);
  }, [open, busy, load, onChanged]);

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1500px,97vw)]">
        <DialogTitle className="sr-only">Newsletter editor</DialogTitle>
        {!draft ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {loadError ?? <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <Workspace
            key={draft.id}
            draft={draft}
            setDraft={setDraft}
            reload={load}
            onChanged={onChanged}
            flushRef={flushRef}
            onClose={() => requestOpenChange(false)}
          />
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
  flushRef,
  onClose,
}: {
  draft: EditorDraft;
  setDraft: (d: EditorDraft) => void;
  reload: () => Promise<EditorDraft | null>;
  onChanged: () => void;
  /** Set to "save if anything's unsaved", run before the dialog closes. */
  flushRef: React.MutableRefObject<() => Promise<boolean>>;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [previewText, setPreviewText] = useState(draft.previewText ?? "");
  const [sections, setSections] = useState<NewsletterSection[]>(draft.sections);
  const [body, setBody] = useState(draft.bodyMarkdown ?? "");
  const [specialCopy, setSpecialCopy] = useState(draft.specialCopy ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Screenshots: any template section can ask for them (its "Screenshots from the video" setting).
  const hasShots = !!draft.template?.sections.some((s) => s.kind !== "sponsor" && s.screenshots);
  // Loaded for every templated draft: any image in the text can be swapped for an upload or a video frame.
  const shots = useScreenshots(draft.id, !!draft.template && draft.status === "ready", draft.screenshotPreviews ?? {});
  const previewShots = { chosen: shots.chosen, urlFor: shots.urlFor };
  const seenRevision = useRef(draft.revision);
  const seenStatus = useRef(draft.status);
  // The revision the next save is based on, and the save in flight (saves run one at a time).
  const revisionRef = useRef(draft.revision);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  // Visual view (every templated newsletter): what's selected on the canvas, and the section open for typing.
  const [view, setView] = useState<"visual" | "text">(draft.template ? "visual" : "text");
  /** The canvas's width: a desktop client or a phone. */
  const [device, setDevice] = useState<Device>("desktop");
  /** The exact email (the HTML that is sent), full screen. */
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [addingShot, setAddingShot] = useState<string | null>(null);
  /** "More ideas": the angle behind each suggested subject line (shown on hover). */
  const [subjectAngles, setSubjectAngles] = useState<Record<string, string>>({});
  /** The review panel is open in the side panel. */
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The format's template, opened from here (its editor, in place). */
  const [templateCtx, setTemplateCtx] = useState<TemplateCtx | null>(null);
  /** "Before you send": the checks' results, the proofread's fixes, the panel. */
  const [sendPanel, setSendPanel] = useState(false);
  const [checks, setChecks] = useState<PreSendCheck[] | null>(null);
  const [fixes, setFixes] = useState<ProofreadFix[] | null>(null);
  const [notes, setNotes] = useState(draft.notes ?? "");
  /** This issue's own design (a designed part edited here), or null = the template's. */
  const [layout, setLayout] = useState<DocNode | null>((draft.layout as DocNode | null) ?? null);
  /** The issue's values for the template's `{fields}` ("{tool} Guide" → "Nano Banana Guide"). */
  const [variables, setVariables] = useState<Record<string, string>>(draft.variables ?? {});
  /** The template's `{fields}` this issue fills (its design's tokens + the template's declared fields). */
  const fieldNames = useMemo(() => {
    if (!draft.template) return [] as string[];
    const t = draft.template;
    return [...new Set([...variableNames(layoutText(layoutFor(t, layout)).join("\n")), ...Object.keys(t.variables ?? {})])];
  }, [draft.template, layout]);
  /**
   * The side panel. Before a click removes the button it came from (+ Add
   * screenshot, a trash icon), focus moves here without scrolling: otherwise
   * the dialog grabs focus back and scrolls the canvas away from the step.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const keepPlace = () => panelRef.current?.focus({ preventScroll: true });
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
    setNotes(draft.notes ?? "");
    setLayout((draft.layout as DocNode | null) ?? null);
    setVariables(draft.variables ?? {});
  }, [draft]);

  const dirty =
    subject !== (draft.subject ?? "") ||
    previewText !== (draft.previewText ?? "") ||
    // Templated drafts never edit the composed body (the server rebuilds it from the sections on each save).
    (!draft.template && body !== (draft.bodyMarkdown ?? "")) ||
    specialCopy !== (draft.specialCopy ?? "") ||
    notes !== (draft.notes ?? "") ||
    JSON.stringify(layout ?? null) !== JSON.stringify(draft.layout ?? null) ||
    JSON.stringify(variables) !== JSON.stringify(draft.variables ?? {}) ||
    !sameSections(sections, draft.sections);

  // Autosave, like the design editor: a moment after the last change.
  useEffect(() => {
    if (!dirty || draft.status !== "ready") return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm on every edit; save() reads the latest state
  }, [dirty, draft.status, subject, previewText, sections, body, specialCopy, notes, layout, variables]);
  flushRef.current = () => (dirty ? save() : saveChain.current);

  const preview = useMemo(() => {
    if (!draft.template) return body;
    return composeIssue(draft.template, sections, specialCopy.trim() ? { copy: specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null);
  }, [draft.template, draft.specialSource, sections, specialCopy, body]);

  /** Save (one at a time). `withSections`: save these instead of the current state (a change made in the same click). */
  function save(withSections?: NewsletterSection[]): Promise<boolean> {
    const next = saveChain.current.then(() => saveNow(withSections));
    saveChain.current = next;
    return next;
  }

  async function saveNow(withSections?: NewsletterSection[]): Promise<boolean> {
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
          notes: notes.trim() || null,
          layout,
          variables,
          revision: revisionRef.current,
          ...(draft.template ? { sections: withSections ?? sections } : { bodyMarkdown: body }),
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

  /** Find new story → the editor picked one: rewrite the section around it. */
  async function pickStory(key: string, story: StoryPick, instruction: string) {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/sections/${key}/regenerate`, { instruction: instruction || null, story }, `regen:${key}`);
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

  /** "Update in beehiiv": the post's body replaced with the email as it is now; `force` after a "edited by hand there" refusal. */
  async function updateBeehiiv(force = false) {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/beehiiv/update`, { force }, "beehiiv");
  }

  async function pushToHubspot() {
    if (dirty && !(await save())) return;
    await post(`/api/newsletter-drafts/${draft.id}/hubspot`, {}, "hubspot");
  }

  /** The AI review: saves first (it reads the saved issue), then runs on the worker; the panel shows the findings. */
  async function startReview() {
    if (dirty && !(await save())) return;
    setReviewOpen(true);
    deselect();
    await post(`/api/newsletter-drafts/${draft.id}/review`, {}, "review");
  }
  async function markFinding(findingId: string, state: "applied" | "dismissed") {
    const res = await fetch(`/api/newsletter-drafts/${draft.id}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ findingId, state }) });
    const json = (await res.json().catch(() => ({}))) as { draft?: EditorDraft };
    if (json.draft) {
      // Our own change: keep local edits (the revision is unchanged).
      setDraft({ ...draft, review: json.draft.review, subjectOptions: draft.subjectOptions });
    }
  }
  /** Apply a finding: regenerate its section with the suggested instruction (or just select the section). */
  async function applyFinding(f: NewsletterReviewFinding) {
    if (f.sectionKey) setSelected(f.sectionKey);
    if (f.sectionKey && f.instruction) {
      await markFinding(f.id, "applied");
      await regenerate(f.sectionKey, f.instruction);
    }
  }
  /** Open the format's template editor right here; saving it redraws this issue with the new design. */
  async function openTemplate() {
    if (!draft.formatId) return;
    if (dirty && !(await save())) return;
    const res = await fetch(`/api/formats/${draft.formatId}/newsletter-template`);
    const j = (await res.json().catch(() => null)) as (TemplateCtx & { template: NewsletterTemplate | null }) | null;
    if (!res.ok || !j?.template) return setMessage("Couldn't open the template");
    setTemplateCtx(j);
  }

  /** Pre-send checks (content + every link fetched); the panel shows them. */
  async function runChecks() {
    if (dirty && !(await save())) return;
    setSendPanel(true);
    deselect();
    setBusyAction("checks");
    setChecks(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${draft.id}/checks`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { checks?: PreSendCheck[]; error?: string };
      if (!res.ok || !json.checks) throw new Error(json.error ?? "Couldn't run the checks");
      setChecks(json.checks);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  }
  /** Proofread: exact typo/grammar fixes, applied to the text here (then autosaved). */
  async function proofread() {
    if (dirty && !(await save())) return;
    setSendPanel(true);
    deselect();
    setBusyAction("proofread");
    setFixes(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${draft.id}/proofread`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { fixes?: ProofreadFix[]; error?: string };
      if (!res.ok || !json.fixes) throw new Error(json.error ?? "Couldn't proofread");
      setFixes(json.fixes);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  }
  const applyProofreadFixes = (which: ProofreadFix[]) => {
    setSections((cur) => applyFixes(cur, which));
    setFixes((cur) => (cur ? cur.filter((f) => !which.includes(f)) : cur));
  };
  /** Send the exact email to the signed-in user (the route never takes a recipient). */
  async function sendTest() {
    if (dirty && !(await save())) return;
    setBusyAction("test-email");
    setMessage(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${draft.id}/test-email`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { sentTo?: string; error?: string };
      if (!res.ok || !json.sentTo) throw new Error(json.error ?? "Couldn't send");
      setMessage(`Test sent to ${json.sentTo}`);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  /** "More ideas": six more subject lines in this newsletter's own habits, appended to the options. */
  async function moreSubjects() {
    setBusyAction("subjects");
    setMessage(null);
    try {
      const res = await fetch(`/api/newsletter-drafts/${draft.id}/subjects`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { ideas?: { subject: string; previewText: string; angle: string }[]; draft?: EditorDraft; error?: string };
      if (!res.ok || !json.ideas || !json.draft) throw new Error(json.error ?? "Couldn't get ideas");
      setSubjectAngles((cur) => ({ ...cur, ...Object.fromEntries(json.ideas!.map((i) => [i.subject, `${i.angle} · preview: ${i.previewText}`])) }));
      // The options grew on the server (revision bumped); keep our local edits and adopt the new list.
      revisionRef.current = json.draft.revision;
      seenRevision.current = json.draft.revision;
      setDraft({ ...draft, revision: json.draft.revision, subjectOptions: json.draft.subjectOptions });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  const sponsorArg = specialCopy.trim() ? { copy: specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null;
  const tool = draft.template?.beehiiv ? "beehiiv" : "HubSpot";
  const pushUrl = draft.template?.beehiiv ? draft.beehiivPostUrl : draft.hubspotEmailUrl;
  const beehiivPreview = draft.template?.beehiiv ? beehiivPreviewUrlFromEditUrl(draft.beehiivPostUrl) : null;
  const pushPending = draft.template?.beehiiv ? draft.beehiivStatus === "pending" : draft.hubspotStatus === "pending";
  const pushBusy = busyAction === "beehiiv" || busyAction === "hubspot" || pushPending;
  const words = draft.status === "ready" ? (draft.template ? sections.map((x) => x.markdown).join(" ") : body).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  const header = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b px-4 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{draft.formatName}</span>
          {draft.template && draft.formatId && (
            <button type="button" onClick={openTemplate} className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Open this newsletter's template: its design and what AI writes in each section">
              <LayoutTemplate className="size-3" /> Template
            </button>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {draft.sendDate ? `Sends ${fmtDate(draft.sendDate)}` : "No send date"}
          {pushUrl ? ` · draft in ${tool}${draft.beehiivStatus === "updated" ? " (updated)" : ""}` : draft.status === "ready" ? " · draft" : ""}
          {words > 0 && ` · ${words} words · ~${Math.max(1, Math.round(words / 200))} min read`}
        </span>
      </div>
      <div className="flex items-center justify-center">
        {draft.status === "ready" && draft.template && view === "visual" && <DeviceToggle device={device} onChange={setDevice} />}
      </div>
      <div className="flex items-center justify-end gap-1.5 pr-8">
        <span className="hidden max-w-[260px] min-w-12 truncate text-right text-xs text-muted-foreground sm:inline" title={message ?? undefined}>
          {saving ? "Saving…" : message}
        </span>
        {draft.status === "ready" && (
          <>
            {draft.template && (
              <Button
                variant="ghost"
                size="sm"
                onClick={startReview}
                disabled={busyAction !== null || draft.review?.status === "running"}
                title="A senior-editor read of the whole issue: voice, structure, facts, links, subject line — with one-click fixes"
              >
                {draft.review?.status === "running" ? <Loader2 className="animate-spin" /> : <Wand2 />}
                AI review
              </Button>
            )}
            {draft.template && (
              <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(true)} title="The exact email that is sent, on desktop and on a phone">
                <Eye />
                Preview
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More" className={buttonVariants({ size: "icon-sm", variant: "ghost" })}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                {draft.template && view === "text" && (
                  <DropdownMenuItem onClick={() => setView("visual")} className="cursor-pointer gap-2">
                    <LayoutTemplate className="size-4" />
                    Visual view
                  </DropdownMenuItem>
                )}
                {draft.template && draft.formatId && (
                  <DropdownMenuItem onClick={openTemplate} className="cursor-pointer gap-2">
                    <LayoutTemplate className="size-4" />
                    Edit template
                  </DropdownMenuItem>
                )}
                {layout && (
                  <DropdownMenuItem onClick={() => setLayout(null)} className="cursor-pointer gap-2">
                    <RotateCcw className="size-4" />
                    Reset to the template&apos;s design
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={redraft} disabled={busyAction !== null} className="cursor-pointer gap-2">
                  <RefreshCw className="size-4" />
                  Redraft the whole issue
                </DropdownMenuItem>
                {draft.template && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={runChecks} disabled={busyAction !== null} className="cursor-pointer gap-2">
                      <ListChecks className="size-4" />
                      Pre-send checks
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={proofread} disabled={busyAction !== null} className="cursor-pointer gap-2">
                      <SpellCheck className="size-4" />
                      Proofread
                    </DropdownMenuItem>
                                          <DropdownMenuItem onClick={sendTest} disabled={busyAction !== null} className="cursor-pointer gap-2">
                        <Mail className="size-4" />
                        Send test to me
                      </DropdownMenuItem>
                  </>
                )}
                {pushUrl && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => window.open(pushUrl, "_blank", "noreferrer")} className="cursor-pointer gap-2">
                      <ExternalLink className="size-4" />
                      Open in {tool}
                    </DropdownMenuItem>
                    {beehiivPreview && (
                      <DropdownMenuItem onClick={() => window.open(beehiivPreview, "_blank", "noreferrer")} className="cursor-pointer gap-2">
                        <Eye className="size-4" />
                        Preview in beehiiv
                      </DropdownMenuItem>
                    )}
                    {draft.template?.beehiiv && (
                      <DropdownMenuItem onClick={() => updateBeehiiv(false)} disabled={busyAction !== null || pushPending} className="cursor-pointer gap-2">
                        <RefreshCw className="size-4" />
                        Update in beehiiv
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving} title="Saves your edits and closes. The newsletter stays in the queue as a Draft until you create the email draft.">
              Save &amp; close
            </Button>
            {pushUrl ? (
              <a href={pushUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>
                Open in {tool} <ExternalLink />
              </a>
            ) : (
              <Button
                size="sm"
                onClick={draft.template?.beehiiv ? pushToBeehiiv : pushToHubspot}
                disabled={busyAction !== null || pushPending}
                title={
                  draft.template?.beehiiv
                    ? "Creates an unsent DRAFT post in beehiiv — this whole email as one HTML block, plus the feedback poll — and moves this newsletter out of the queue into production. beehiiv's editor shows that block as code; its Preview toggle renders it. Never sends or schedules."
                    : `Creates an unsent DRAFT in ${tool} — the whole email, exactly as shown here — and moves this newsletter out of the queue into production. Never sends or schedules.`
                }
              >
                {pushBusy && <Loader2 className="animate-spin" />}
                Create draft in {tool}
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
  const selSection = selected && !selected.startsWith("shot:") && !selected.startsWith("img:") ? (draft.template?.sections.find((s) => s.key === selected) ?? null) : null;
  const selShot = selected?.startsWith("shot:") ? selected.slice(5) : null;
  const shotMark = selShot ? (draft.template?.sections.flatMap((s) => parseScreenshotMarks(s.key, sectionMd(s.key))).find((m) => m.key === selShot) ?? null) : null;

  // Images in the text (the video thumbnail, or any other): the nth Markdown image of a section.
  const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const imageAt = (key: string, index: number) => {
    const m = [...sectionMd(key).matchAll(IMAGE_RE)][index];
    return m ? { alt: m[1], url: m[2] } : null;
  };
  const replaceImage = (key: string, index: number, replacement: string) => {
    let i = 0;
    return sectionMd(key).replace(IMAGE_RE, (whole) => (i++ === index ? replacement : whole));
  };
  const withSection = (key: string, md: string) => sections.map((x) => (x.key === key ? { ...x, markdown: md } : x));
  /** Change a section's text and save it right away (an image swap is one click, not a typing session). */
  const commitSection = async (key: string, md: string) => {
    setSectionMd(key, md);
    return save(withSection(key, md));
  };
  /**
   * Swapping an image for an upload or a frame turns it into a screenshot
   * placeholder (same label), so the pick works like any screenshot: frames,
   * scrubber, uploads, and both pushes.
   */
  const imageToPlaceholder = async (key: string, index: number): Promise<string | null> => {
    const img = imageAt(key, index);
    if (!img) return null;
    const taken = new Set(parseScreenshotMarks(key, sectionMd(key)).map((m) => m.label.toLowerCase()));
    const base = (img.alt.trim() || "Image").replace(/[[\]*_]/g, "").slice(0, 80);
    let label = base;
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} ${n}`;
    if (!(await commitSection(key, replaceImage(key, index, `*[Screenshot: ${label}]*`)))) return null;
    const markKey = screenshotKey(key, label);
    setSelected(`shot:${markKey}`);
    return markKey;
  };
  /** Trash: the screenshot out of the text entirely (its pick cleared too). */
  const deleteShot = async (sectionKey: string, markKey: string) => {
    keepPlace();
    setSelected(null);
    setEditingSection(null);
    await commitSection(sectionKey, removeScreenshotMark(sectionMd(sectionKey), sectionKey, markKey));
    if (shots.chosen[markKey]) await shots.choose(markKey, null);
  };
  /**
   * "+ Add screenshot" under step `n`: Haiku finds when the step happens in the
   * video, the placeholder goes in after the step's text, and the auto-pick
   * grabs that frame + its strip; the picker opens to adjust. Without a moment
   * the placeholder still goes in, to pick by hand.
   */
  const addShot = async (sectionKey: string, n: number) => {
    const step = stepsWithoutScreenshots(sectionMd(sectionKey)).find((s) => s.n === n);
    if (!step) return;
    keepPlace();
    setEditingSection(null);
    setAddingShot(`${sectionKey}:${n}`);
    try {
      const moment = await shots.suggest(sectionKey, step.text);
      const taken = new Set(parseScreenshotMarks(sectionKey, sectionMd(sectionKey)).map((m) => m.label.toLowerCase()));
      const base = moment?.label ?? `Step ${n}`;
      let label = base;
      for (let k = 2; taken.has(label.toLowerCase()); k++) label = `${base} ${k}`;
      const placeholder = moment ? `*[Screenshot @ ${formatTimestamp(moment.sec)}: ${label}]*` : `*[Screenshot: ${label}]*`;
      if (!(await commitSection(sectionKey, insertStepScreenshot(sectionMd(sectionKey), n, placeholder)))) return;
      const markKey = screenshotKey(sectionKey, label);
      setSelected(`shot:${markKey}`);
      // Grabs + picks the frame at its moment (and its strip), and reloads the screenshot state either way.
      await shots.autoPick();
    } finally {
      setAddingShot(null);
    }
  };
  /** A screenshot placeholder back to the section's video thumbnail. */
  const placeholderToThumbnail = async (mark: ScreenshotMark) => {
    const videoId = shots.sectionVideos[mark.sectionKey];
    const thumb = videoId ? shots.thumbnails[videoId] : null;
    if (!thumb) return;
    if (shots.chosen[mark.key]) await shots.choose(mark.key, null);
    await commitSection(mark.sectionKey, sectionMd(mark.sectionKey).replace(mark.raw, `![${mark.label}](${thumb})`));
    setSelected(null);
  };
  const selImage = selected?.startsWith("img:") ? (() => {
    const [, key, n] = selected.split(":");
    const img = imageAt(key, Number(n));
    return img ? { key, index: Number(n), ...img } : null;
  })() : null;
  const sectionVideoUrl = (key: string) => {
    const v = shots.sectionVideos[key];
    return v ? (shots.videoUrls[v] ?? null) : null;
  };
  const sectionThumb = (key: string) => {
    const v = shots.sectionVideos[key];
    return v ? (shots.thumbnails[v] ?? null) : null;
  };

  const sourcesList = draft.sources.length > 0 && draft.kind === "roundup" && (
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
);

  const subjectFields = (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Subject</span>
          <Button size="xs" variant="ghost" onClick={moreSubjects} disabled={busyAction !== null} title="Six more subject lines in this newsletter's own habits, each from a different angle">
            {busyAction === "subjects" ? <Loader2 className="animate-spin" /> : <Lightbulb />}
            More ideas
          </Button>
        </div>
        {draft.subjectOptions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {draft.subjectOptions.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSubject(opt)}
                title={subjectAngles[opt]}
                className={cn("rounded-full border px-3 py-1 text-left text-xs hover:bg-muted", subject === opt && "border-primary bg-muted", subjectAngles[opt] && subject !== opt && "border-dashed")}
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
      {fieldNames.length > 0 && (
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Template fields</span>
          <p className="text-xs text-muted-foreground">Blanks in the design the drafter filled for this issue (card labels, a heading). Change one and the email updates.</p>
          {fieldNames.map((name) => {
            const v = draft.template?.variables?.[name];
            return (
              <label key={name} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate font-mono text-muted-foreground" title={v?.hint || `{${name}}`}>{`{${name}}`}</span>
                <Input className="h-8 text-xs" value={variables[name] ?? ""} placeholder={v?.sample || ""} onChange={(e) => setVariables({ ...variables, [name]: e.target.value })} />
              </label>
            );
          })}
        </div>
      )}
    </>
  );

  const exactHtml = useMemo(
    () => (draft.template ? renderEmailHtml({ template: draft.template, sections, sponsor: sponsorArg, subject, previewText, screenshots: previewShots, footerNote: draft.template.beehiiv ? null : FOOTER_NOTE, layout, variables }) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- previewShots is rebuilt each render; its parts are what matters
    [draft.template, sections, sponsorArg, subject, previewText, shots.chosen, shots.urlFor, layout, variables],
  );
  const canvasWidth = device === "mobile" ? MOBILE_WIDTH : EMAIL_WIDTH;
  const visual = draft.template ? (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto px-5 pt-5" style={{ maxWidth: canvasWidth + 40 }}>
          <button
            type="button"
            onClick={deselect}
            title="Edit the subject and preview text"
            className={cn(
              "flex w-full items-start gap-3 rounded-xl border bg-background px-4 py-3 text-left shadow-sm transition-shadow hover:shadow-md",
              !selected && "ring-2 ring-[#49adff]",
            )}
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {draft.formatName.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">{subject || "(no subject)"}</span>
              <span className="truncate text-xs text-muted-foreground">{previewText || "(no preview text)"}</span>
            </span>
          </button>
        </div>
        <div className={cn(device === "mobile" && "flex justify-center px-5 py-5")}>
          <div className={cn(device === "mobile" && "overflow-hidden rounded-[32px] border-[10px] border-[#1f2937] bg-[#1f2937] shadow-xl")} style={device === "mobile" ? { width: MOBILE_WIDTH + 20 } : undefined}>
            <EmailPreview
              template={draft.template}
              sections={sections}
              sponsor={sponsorArg}
              screenshots={previewShots}
              width={canvasWidth}
              layout={layout}
              variables={variables}
              edit={{
                selected,
                editingSection,
                regenerating: draft.regenerating,
                onSelectSection: (key) => {
                  setSelected(key);
                  setEditingSection(key);
                },
                onChangeSection: (key, md) => {
                  // The sponsor's slot: the promo copy when there is some, else the section's text.
                  if (draft.template?.sections.find((s) => s.key === key)?.kind === "sponsor" && specialCopy.trim()) setSpecialCopy(md);
                  else setSectionMd(key, md);
                },
                onChangeDesign: (path, nodes, count) => setLayout((cur) => replaceAtPath(cur ?? layoutFor(draft.template!), path, nodes, count)),
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
                onSelectImage: (key, index) => {
                  setEditingSection(null);
                  setSelected(`img:${key}:${index}`);
                },
                onDeleteShot: (key, markKey) => void deleteShot(key, markKey),
                onRemoveImage: (key, index) => {
                  keepPlace();
                  setSelected(null);
                  setEditingSection(null);
                  void commitSection(key, replaceImage(key, index, "").replace(/\n{3,}/g, "\n\n"));
                },
                onAddShot: (key, n) => void addShot(key, n),
                addingShot,
                onEditTemplate: draft.formatId ? () => void openTemplate() : undefined,
                shotUrl: (sectionKey, label) => {
                  const k = screenshotKey(sectionKey, label);
                  const c = shots.chosen[k];
                  return c ? shots.urlFor(c, k) : null;
                },
                onDropImage: (key, index, file) => {
                  setEditingSection(null);
                  void imageToPlaceholder(key, index).then((markKey) => {
                    if (markKey) void shots.upload(markKey, file);
                  });
                },
              }}
            />
          </div>
        </div>
        <p className="flex items-center justify-center gap-1.5 px-5 pb-6 text-center text-xs text-muted-foreground">
          <MousePointerClick className="size-3.5" /> Click any text to edit it in place · click an image or screenshot to swap it, or drop a file on it
          {" · this is the email itself, exactly as it sends"}
        </p>
      </div>

      <div ref={panelRef} tabIndex={-1} className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l p-4 outline-none">
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
              busyAction={busyAction}
              onAction={special}
            />
          ) : (
            <>
              <SectionEditor
                key={selSection.key}
                draftId={draft.id}
                sectionKey={selSection.key}
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
                onFindNewStory={draft.kind === "roundup" && !draft.sourceItemId ? (instruction) => regenerate(selSection.key, instruction, true) : undefined}
                    onPickStory={draft.kind === "roundup" && !draft.sourceItemId ? (story, instruction) => void pickStory(selSection.key, story, instruction) : undefined}
                onCancel={() => cancelRun(selSection.key)}
              />
              <p className="text-xs text-muted-foreground">
                {editingSection === selSection.key
                  ? "You're editing the email itself: the toolbar above the text does bold, italic, links, headings, lists, buttons, images and the reader's first name (⌘B / ⌘I work too). Click outside or press Esc to finish; it saves on its own."
                  : "Click the section in the email to edit its text."}
              </p>
            </>
          )
        ) : selShot ? (
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium">Screenshot</span>
            {shotMark ? (
              <ScreenshotMarkPanel
                key={shotMark.key}
                mark={shotMark}
                shots={shots}
                onUseThumbnail={() => void placeholderToThumbnail(shotMark)}
                onDelete={() => void deleteShot(shotMark.sectionKey, shotMark.key)}
              />
            ) : (
              <span className="text-xs text-muted-foreground">This placeholder is no longer in the text.</span>
            )}
            {shots.error && <span className="text-xs text-destructive">{shots.error}</span>}
          </div>
        ) : selImage ? (
          <ImagePanel
            key={selected!}
            url={selImage.url}
            alt={selImage.alt}
            isThumbnail={isVideoThumbnail(selImage.url)}
            videoUrl={sectionVideoUrl(selImage.key)}
            transcript={(() => {
              const v = shots.sectionVideos[selImage.key];
              return v ? (shots.transcripts[v] ?? []) : [];
            })()}
            thumbnailUrl={sectionThumb(selImage.key)}
            busy={saving || shots.busy !== null}
            onUpload={(file) => void imageToPlaceholder(selImage.key, selImage.index).then((markKey) => {
                if (markKey) void shots.upload(markKey, file);
              })}
            onGrab={(sec) => void imageToPlaceholder(selImage.key, selImage.index).then((markKey) => {
                if (markKey) void shots.grabAt(markKey, sec);
              })}
            onUseThumbnail={() => {
              const thumb = sectionThumb(selImage.key);
              if (thumb) void commitSection(selImage.key, replaceImage(selImage.key, selImage.index, `![${selImage.alt}](${thumb})`));
            }}
            onRemove={() => {
              void commitSection(selImage.key, replaceImage(selImage.key, selImage.index, "").replace(/\n{3,}/g, "\n\n"));
              setSelected(null);
            }}
          />
        ) : sendPanel ? (
          <SendPanel
            checks={checks}
            fixes={fixes}
            busy={busyAction}
            sections={draft.template?.sections ?? []}
            canSendTest
            onChecks={runChecks}
            onProofread={proofread}
            onSendTest={sendTest}
            onApplyFixes={applyProofreadFixes}
            onSelect={(key) => setSelected(key)}
            onClose={() => setSendPanel(false)}
          />
        ) : reviewOpen && draft.review ? (
          <ReviewPanel
            review={draft.review}
            sections={draft.template?.sections ?? []}
            busy={busyAction !== null}
            regenerating={draft.regenerating}
            onApply={(f) => void applyFinding(f)}
            onDismiss={(f) => void markFinding(f.id, "dismissed")}
            onSelect={(key) => setSelected(key)}
            onClose={() => setReviewOpen(false)}
            onAgain={startReview}
          />
        ) : (
          <>
            {subjectFields}
            {draft.review && draft.review.status !== "running" && (
              <button type="button" onClick={() => setReviewOpen(true)} className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-muted/60">
                <Wand2 className="size-3.5 text-primary" />
                <span className="flex-1">
                  AI review: {draft.review.findings.filter((f) => !f.state).length} open finding{draft.review.findings.filter((f) => !f.state).length === 1 ? "" : "s"}
                  {draft.review.revision !== draft.revision ? " (from an earlier version)" : ""}
                </span>
                <span className="text-muted-foreground">Open</span>
              </button>
            )}
            {draft.template && (
              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <span className="text-xs font-medium">Before you send</span>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="xs" variant="outline" onClick={runChecks} disabled={busyAction !== null} title="Empty sections, placeholders, subject length, every link and image fetched">
                    {busyAction === "checks" ? <Loader2 className="animate-spin" /> : <ListChecks />}
                    Checks
                  </Button>
                  <Button size="xs" variant="outline" onClick={proofread} disabled={busyAction !== null} title="Exact typo and grammar fixes — never a rewrite">
                    {busyAction === "proofread" ? <Loader2 className="animate-spin" /> : <SpellCheck />}
                    Proofread
                  </Button>
                                      <Button size="xs" variant="outline" onClick={sendTest} disabled={busyAction !== null} title="Emails the exact email to you (only you)">
                      {busyAction === "test-email" ? <Loader2 className="animate-spin" /> : <Mail />}
                      Send test to me
                    </Button>
                </div>
              </div>
            )}
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Notes for the drafter</span>
              <Textarea className="min-h-16 text-xs" placeholder="An offer to pitch, an angle, a story to feature — Regenerate and Redraft read this." value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
              Click any part of the email to edit it. Text opens right where it is, with Regenerate{draft.kind === "roundup" && !draft.sourceItemId ? " and Find new story" : ""} here{hasShots ? "; a screenshot opens its video scrubber, frames, Upload and Remove" : ""}. Headings, the masthead and other designed parts come from the template: edit them here for this issue, or open Template to change every issue.
            </p>
            {sourcesList}
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {header}
      {previewOpen && exactHtml && <ExactPreview html={exactHtml} device={device} onDevice={setDevice} onClose={() => setPreviewOpen(false)} beehiiv={!!draft.template?.beehiiv} />}
      {templateCtx && draft.formatId && templateCtx.template && (
        <TemplateEditorDialog
          formatId={draft.formatId}
          initial={templateCtx.template}
          storyCtx={{ singleVideoNote: templateCtx.singleVideoNote, caseStudies: templateCtx.caseStudies }}
          hubspotUrl={templateCtx.hubspotTemplateUrl ?? null}
          onClose={() => setTemplateCtx(null)}
          onSaved={() => {
            setTemplateCtx(null);
            void reload();
          }}
        />
      )}
      {draft.kind === "single_video" && <VideoBar draft={draft} disabled={draft.status === "drafting" || busyAction !== null} onPick={(itemId) => post(`/api/newsletter-drafts/${draft.id}/video`, { itemId }, "video")} />}
      {draft.kind === "roundup" && draft.sourceItemId && (
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2 text-sm">
          <span className="font-medium">About one video</span>
          <span className="truncate text-muted-foreground">{draft.sourceTitle ?? "the picked video"}</span>
          {draft.sourceUrl && (
            <a className="text-xs text-primary underline" href={draft.sourceUrl} target="_blank" rel="noreferrer">
              Watch
            </a>
          )}
          <span className="text-xs text-muted-foreground">Every story section takes an angle on it.</span>
        </div>
      )}
      {draft.hubspotStatus === "failed" && draft.hubspotError && (
        <p className="mx-5 mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">Email push: {draft.hubspotError}</p>
      )}
      {draft.template?.beehiiv && draft.beehiivPostUrl && (
        <p className="mx-5 mt-3 rounded-md bg-muted p-2 text-xs text-muted-foreground">
          In beehiiv this email is one <span className="font-medium text-foreground">HTML Snippet</span> block: the editor shows its code, and the block&apos;s <span className="font-medium text-foreground">Preview</span> toggle (or{" "}
          {beehiivPreview ? (
            <a className="underline" href={beehiivPreview} target="_blank" rel="noreferrer">
              the post&apos;s preview
            </a>
          ) : (
            "the post's preview"
          )}
          ) shows the design. Change the subject, preview text or send settings there. The words and design are edited here: fix them, then{" "}
          <button
            type="button"
            onClick={() => updateBeehiiv(false)}
            disabled={busyAction !== null || pushPending}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
            title="Replaces the beehiiv draft's body with this email as it is now. The subject, preview text and send settings you set in beehiiv stay. Refuses a post that was sent, scheduled or edited by hand there."
          >
            {pushBusy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Update in beehiiv
          </button>{" "}
          replaces the post&apos;s body.
        </p>
      )}
      {draft.beehiivStatus === "failed" && draft.beehiivError && (
        <p className="mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
          <span>beehiiv: {draft.beehiivError}</span>
          {draft.beehiivPostUrl && draft.beehiivError.includes("edited by hand") && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => updateBeehiiv(true)} disabled={busyAction !== null || pushPending}>
              Replace anyway
            </Button>
          )}
        </p>
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
                    busyAction={busyAction}
                    onAction={special}
                  />
                ) : (
                  <SectionEditor
                    key={sec.key}
                    draftId={draft.id}
                    sectionKey={sec.key}
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
                    onFindNewStory={draft.kind === "roundup" && !draft.sourceItemId ? (instruction) => regenerate(sec.key, instruction, true) : undefined}
                    onPickStory={draft.kind === "roundup" && !draft.sourceItemId ? (story, instruction) => void pickStory(sec.key, story, instruction) : undefined}
                    onCancel={() => cancelRun(sec.key)}
                  >
                    {hasShots && (
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

            {sourcesList}
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
                <EmailPreview template={draft.template} sections={sections} screenshots={previewShots} sponsor={sponsorArg} variables={variables} />
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

type Device = "desktop" | "mobile";

/** What the format's template route returns (GET /api/formats/[id]/newsletter-template). */
interface TemplateCtx {
  template: NewsletterTemplate | null;
  hubspotTemplateUrl?: string | null;
  singleVideoNote: string | null;
  caseStudies: boolean;
}

/** Desktop / phone, for the canvas and the exact preview. */
function DeviceToggle({ device, onChange }: { device: Device; onChange: (d: Device) => void }) {
  return (
    <div className="flex items-center rounded-lg border bg-muted/50 p-0.5 text-xs" role="radiogroup" aria-label="Preview width">
      {(
        [
          ["desktop", Monitor, "Desktop"],
          ["mobile", Smartphone, "Phone"],
        ] as const
      ).map(([d, Icon, label]) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={device === d}
          onClick={() => onChange(d)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors",
            device === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** The exact email — the HTML that is sent — in a sandboxed frame, at desktop or phone width. */
function ExactPreview({ html, device, onDevice, onClose, beehiiv }: { html: string; device: Device; onDevice: (d: Device) => void; onClose: () => void; beehiiv: boolean }) {
  const mobile = device === "mobile";
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Eye className="size-4" /> {beehiiv ? "The email as designed" : "Exactly what lands in the inbox"}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {beehiiv ? "The HTML that goes to beehiiv, rendered as-is. beehiiv adds the feedback poll and the footer." : "The HTML that goes to HubSpot, rendered as-is. HubSpot adds the footer."}
          </span>
        </div>
        <DeviceToggle device={device} onChange={onDevice} />
        <div className="flex justify-end pr-8">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="exact-preview-close">
            <X /> Close
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted/40 p-5">
        <div
          className={cn("h-full", mobile && "overflow-hidden rounded-[32px] border-[10px] border-[#1f2937] bg-[#1f2937] shadow-xl")}
          style={{ width: mobile ? MOBILE_WIDTH + 20 : Math.min(EMAIL_WIDTH + 160, 900), maxWidth: "100%", maxHeight: mobile ? 820 : undefined }}
        >
          <iframe title="Email preview" srcDoc={html} sandbox="" className={cn("block h-full w-full bg-white", !mobile && "rounded-xl border shadow-sm")} />
        </div>
      </div>
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
const PHASE_LABELS: Record<DraftPhaseName, string> = {
  starting: "Getting ready",
  gathering: "Finding stories",
  reading: "Reading sources",
  writing: "Writing",
  reviewing: "Reviewing",
};

function DraftingPanel({ draft, cancelling, onCancel }: { draft: EditorDraft; cancelling: boolean; onCancel: () => void }) {
  const now = useNow();
  const left = Math.ceil((Date.parse(draft.updatedAt) + NEWSLETTER_START_DELAY_MS - now) / 1000);
  const p = draft.progress ?? null;
  // One video (a How-To, or a roundup the editor pinned to one piece): there are no stories to find.
  const oneVideo = draft.kind === "single_video" || !!draft.sourceItemId;
  const phase = oneVideo && p?.phase === "gathering" ? "reading" : (p?.phase ?? null);
  const pct = left > 0 ? 0 : draftProgress(phase, p ? now - Date.parse(p.at) : 0);
  const elapsed = p ? Math.max(0, Math.round((now - Date.parse(p.startedAt)) / 1000)) : 0;
  const current = phase ? DRAFT_PHASES.indexOf(phase) : -1;
  const steps = DRAFT_PHASES.filter((ph) => ph !== "starting" && !(ph === "gathering" && oneVideo));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Sparkles className="size-6 animate-pulse text-pink-500" />
      <span className="text-sm font-medium text-foreground">{left > 0 ? `Starting in ${left}s…` : `Drafting ${draft.formatName}…`}</span>
      {left <= 0 && (
        <div className="flex w-full max-w-md flex-col gap-2">
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-pink-500 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct * 100)}%` }} />
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            {steps.map((ph) => {
              const i = DRAFT_PHASES.indexOf(ph);
              const done = current > i;
              const now_ = current === i;
              return (
                <span key={ph} className={cn("flex items-center gap-1", done && "text-foreground", now_ && "font-medium text-pink-600 dark:text-pink-400")}>
                  {done ? <Check className="size-3" /> : now_ ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-muted-foreground/40" />}
                  {PHASE_LABELS[ph]}
                </span>
              );
            })}
          </div>
          <span className="text-xs text-foreground/80">
            {p?.detail ?? "Starting…"}
            {p && ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
          </span>
        </div>
      )}
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

/** One-click rewrite steers (each is just an instruction to Regenerate). */
const REWRITE_PRESETS: { label: string; instruction: string }[] = [
  { label: "Shorter", instruction: "Cut it to about half the length. Keep the strongest specific detail and the link; drop warm-up sentences." },
  { label: "Punchier", instruction: "Make it punchier: shorter sentences, a sharper first line, one concrete number or detail up front, no filler." },
  { label: "More personal", instruction: "Make it more personal and first-person, the way Pat talks to a friend: a specific reaction or aside, less summary." },
  { label: "Add a number", instruction: "Lead with the most striking specific number or result from the source (revenue, time, customers). Never invent one — if the source has none, lead with its most concrete detail." },
  { label: "Simpler", instruction: "Simplify the language: plain words, no jargon, one idea per sentence, same facts." },
];

function SectionEditor({
  draftId,
  sectionKey,
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
  onPickStory,
  onCancel,
  hideText = false,
  children,
}: {
  draftId: string;
  sectionKey: string;
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
  /** Find new story → a story the editor picked in the search. */
  onPickStory?: (story: StoryPick, instruction: string) => void;
  onCancel?: () => void;
  /** Visual view: the text is edited in the email itself, not here. */
  hideText?: boolean;
  /** Extra controls under the section (the How-To's screenshot picker). */
  children?: React.ReactNode;
}) {
  const [instruction, setInstruction] = useState("");
  const { ref: formatRef, apply: applyFormat } = useInlineFormat();
  // "Write it like a past issue": how this section read before, loaded when opened.
  const [examples, setExamples] = useState<{ subject: string | null; publishedAt: string | null; text: string }[] | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const loadExamples = () => {
    setExamplesOpen((o) => !o);
    if (examples) return;
    void fetch(`/api/newsletter-drafts/${draftId}/examples?section=${encodeURIComponent(sectionKey)}`)
      .then((r) => (r.ok ? r.json() : { examples: [] }))
      .then((j: { examples: { subject: string | null; publishedAt: string | null; text: string }[] }) => setExamples(j.examples));
  };
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
      {(source || onPickStory) && (
        <StoryCard
          draftId={draftId}
          source={source}
          usage={usage}
          canSwap={!!onPickStory}
          busy={disabled || regenerating}
          onPick={(story) => onPickStory?.(story, instruction)}
          onAuto={() => {
            onFindNewStory?.(instruction);
            setInstruction("");
          }}
        />
      )}
      {!hideText && (
        <Textarea
          ref={formatRef}
          className="min-h-28 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Cmd+B / Cmd+I, same as the visual view.
          onKeyDown={(e) => {
            const mark = formatShortcut(e);
            const next = mark ? applyFormat(value, mark) : null;
            if (next == null) return;
            e.preventDefault();
            onChange(next);
          }}
          disabled={regenerating}
        />
      )}
      {children}
      <div className="flex flex-wrap items-center gap-1">
        {REWRITE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={disabled || regenerating}
            onClick={() => onRegenerate(p.instruction)}
            title={p.instruction}
            className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || regenerating}
          onClick={loadExamples}
          title="Rewrite it the way a past issue did this section"
          className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-50", examplesOpen && "border-primary text-foreground")}
        >
          <History className="size-3" /> Like a past issue
        </button>
      </div>
      {examplesOpen && (
        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border bg-muted/30 p-1.5">
          {examples === null ? (
            <span className="flex items-center gap-1.5 p-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Reading past issues…
            </span>
          ) : examples.length === 0 ? (
            <span className="p-1 text-xs text-muted-foreground">No past issue has this section on record yet.</span>
          ) : (
            examples.map((ex, i) => (
              <button
                key={i}
                type="button"
                disabled={disabled || regenerating}
                onClick={() => {
                  setExamplesOpen(false);
                  onRegenerate(`Write it the way this past issue did this section — same shape, length and voice, with THIS issue's story and facts (never its content):\n"""\n${ex.text}\n"""`);
                }}
                className="rounded-md px-2 py-1.5 text-left hover:bg-background"
                title={ex.text}
              >
                <span className="block truncate text-xs font-medium">{ex.subject ?? "Untitled issue"}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {ex.publishedAt ? `${ex.publishedAt.slice(0, 10)} · ` : ""}
                  {ex.text.replace(/\s+/g, " ").slice(0, 90)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <div className={cn("flex items-center gap-2", hideText && "flex-wrap")}>
        <Input
          className={cn("h-7 text-xs", hideText && "basis-full")}
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
      </div>
    </div>
  );
}

/** "Before you send": the pre-send checks, the proofread's fixes, and the test send. */
function SendPanel({
  checks,
  fixes,
  busy,
  sections,
  canSendTest,
  onChecks,
  onProofread,
  onSendTest,
  onApplyFixes,
  onSelect,
  onClose,
}: {
  checks: PreSendCheck[] | null;
  fixes: ProofreadFix[] | null;
  busy: string | null;
  sections: { key: string; heading: string | null }[];
  canSendTest: boolean;
  onChecks: () => void;
  onProofread: () => void;
  onSendTest: () => void;
  onApplyFixes: (fixes: ProofreadFix[]) => void;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const nameOf = (key: string | null | undefined) => (key ? (sections.find((s) => s.key === key)?.heading ?? key.replace(/_/g, " ")) : null);
  const icon = (level: PreSendCheck["level"]) =>
    level === "error" ? <CircleAlert className="size-3.5 shrink-0 text-red-600" /> : level === "warn" ? <AlertTriangle className="size-3.5 shrink-0 text-amber-600" /> : <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />;
  const problems = checks?.filter((c) => c.level !== "ok") ?? [];
  const fine = checks?.filter((c) => c.level === "ok") ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ListChecks className="size-4 text-primary" /> Before you send
        </span>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="outline" onClick={onChecks} disabled={busy !== null}>
          {busy === "checks" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {checks ? "Check again" : "Run checks"}
        </Button>
        <Button size="xs" variant="outline" onClick={onProofread} disabled={busy !== null}>
          {busy === "proofread" ? <Loader2 className="animate-spin" /> : <SpellCheck />}
          {fixes ? "Proofread again" : "Proofread"}
        </Button>
        {canSendTest && (
          <Button size="xs" variant="outline" onClick={onSendTest} disabled={busy !== null} title="Emails the exact email to you (only you)">
            {busy === "test-email" ? <Loader2 className="animate-spin" /> : <Mail />}
            Send test to me
          </Button>
        )}
      </div>
      {busy === "checks" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking the text and fetching every link…
        </p>
      )}
      {checks && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{problems.length ? `${problems.length} to look at` : "All clear"}</span>
          {problems.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => c.sectionKey && onSelect(c.sectionKey)}
              className={cn("flex items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs", c.level === "error" ? "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-900/10" : "border-amber-200 bg-amber-50/50 dark:border-amber-800/50 dark:bg-amber-900/10", c.sectionKey && "cursor-pointer hover:bg-muted/40")}
            >
              {icon(c.level)}
              <span className="min-w-0 flex-1 break-words">
                {nameOf(c.sectionKey) && <span className="font-medium">{nameOf(c.sectionKey)}: </span>}
                {c.message}
              </span>
            </button>
          ))}
          {fine.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{fine.length} OK</summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {fine.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5 break-all">
                    {icon("ok")} {c.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {busy === "proofread" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading for typos and slips…
        </p>
      )}
      {fixes && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{fixes.length ? `${fixes.length} fix${fixes.length === 1 ? "" : "es"}` : "No typos found"}</span>
            {fixes.length > 1 && (
              <Button size="xs" onClick={() => onApplyFixes(fixes)}>
                <Check /> Apply all
              </Button>
            )}
          </div>
          {fixes.map((f, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs">
              <span className="text-[11px] text-muted-foreground">
                {nameOf(f.sectionKey)} · {f.why}
              </span>
              <span>
                <span className="rounded bg-red-50 px-1 line-through decoration-red-400 dark:bg-red-900/20">{f.find}</span> →{" "}
                <span className="rounded bg-emerald-50 px-1 dark:bg-emerald-900/20">{f.replace}</span>
              </span>
              <Button size="xs" variant="outline" className="self-start" onClick={() => onApplyFixes([f])}>
                <Check /> Apply
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The AI review's findings: apply (regenerate the section with the fix) or dismiss, one by one. */
function ReviewPanel({
  review,
  sections,
  busy,
  regenerating,
  onApply,
  onDismiss,
  onSelect,
  onClose,
  onAgain,
}: {
  review: NewsletterReview;
  sections: { key: string; heading: string | null }[];
  busy: boolean;
  regenerating: string[];
  onApply: (f: NewsletterReviewFinding) => void;
  onDismiss: (f: NewsletterReviewFinding) => void;
  onSelect: (key: string) => void;
  onClose: () => void;
  onAgain: () => void;
}) {
  const nameOf = (key: string | null) => (key ? (sections.find((s) => s.key === key)?.heading ?? key.replace(/_/g, " ")) : "Whole issue");
  const open = review.findings.filter((f) => !f.state);
  const done = review.findings.filter((f) => f.state);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Wand2 className="size-4 text-primary" /> AI review
        </span>
        <div className="flex items-center gap-1">
          {review.status !== "running" && (
            <Button size="xs" variant="ghost" onClick={onAgain} disabled={busy} title="Review the issue as it stands now">
              <RefreshCw /> Again
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close the review">
            <X />
          </Button>
        </div>
      </div>
      {review.status === "running" ? (
        <p className="flex items-center gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading the whole issue against the Skill, the style notes and past issues… usually under a minute.
        </p>
      ) : review.status === "failed" ? (
        <p className="rounded-md bg-red-50 p-3 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">The review failed: {review.error}</p>
      ) : (
        <>
          {review.summary && <p className="rounded-md bg-muted/60 p-3 text-xs leading-relaxed">{review.summary}</p>}
          {open.length === 0 && <p className="text-xs text-muted-foreground">Nothing left to fix{done.length ? " — every finding is applied or dismissed" : ""}.</p>}
          {open.map((f) => (
            <div key={f.id} className={cn("flex flex-col gap-2 rounded-lg border p-3", f.severity === "fix" ? "border-amber-300/70 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-900/10" : "")}>
              <div className="flex items-center gap-2">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", f.severity === "fix" ? "bg-amber-200 text-amber-900" : "bg-muted text-muted-foreground")}>
                  {f.severity === "fix" ? "Fix" : "Consider"}
                </span>
                <button type="button" onClick={() => f.sectionKey && onSelect(f.sectionKey)} className={cn("truncate text-xs font-medium", f.sectionKey && "hover:underline")}>
                  {nameOf(f.sectionKey)}
                </button>
              </div>
              <p className="text-xs leading-relaxed">{f.note}</p>
              {f.instruction && <p className="text-[11px] italic text-muted-foreground">Fix: {f.instruction}</p>}
              <div className="flex items-center gap-1">
                {f.sectionKey && f.instruction && (
                  <Button size="xs" onClick={() => onApply(f)} disabled={busy || regenerating.includes(f.sectionKey)} title="Regenerate the section with this fix">
                    {regenerating.includes(f.sectionKey) ? <Loader2 className="animate-spin" /> : <Check />}
                    Apply
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => onDismiss(f)} disabled={busy}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
          {done.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{done.length} applied or dismissed</summary>
              <ul className="mt-1 flex flex-col gap-1">
                {done.map((f) => (
                  <li key={f.id} className="line-through">
                    {nameOf(f.sectionKey)}: {f.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function SponsorSection({
  label,
  draft,
  busyAction,
  onAction,
}: {
  label: string;
  draft: EditorDraft;
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
      <p className="rounded-md bg-white/70 p-2 text-xs text-muted-foreground dark:bg-transparent">Edit the copy right in the email: click the section there.</p>
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
