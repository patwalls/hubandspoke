"use client";

// Format page card: the format's newsletter TEMPLATE shown as the real email
// (each AI section's instructions where its content goes), plus "Edit
// template". The editor is ONE builder for every newsletter (HubSpot and
// beehiiv alike, 2026-10-23): the canvas is the email, designed WYSIWYG
// (layout-editor.tsx — images, headings, labels, pills, boxes, buttons,
// dividers, fixed text) with AI section blocks whose instructions / story /
// screenshots live in the side panel, a Look panel for colors and fonts, and
// a Desktop / Phone toggle. No locks. Flag `newsletterDrafter`.

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ExternalLink, GraduationCap, Info, LayoutTemplate, Loader2, Monitor, MousePointerClick, Palette, Pencil, Plus, RotateCcw, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { startVisibleInterval } from "@/lib/visible-interval";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { EmailPreview } from "@/components/dashboard/email-preview";
import { LayoutEditor, removeSlot } from "@/components/dashboard/layout-editor";
import { defaultSection, layoutFor, newSlotKey, withLayout, type LayoutDoc } from "@/lib/newsletter-layout";
import { bodyStyle } from "@/lib/newsletter-email-html";
import { cn } from "@/lib/utils";
import {
  STORY_KIND_LABELS,
  STORY_KINDS,
  type NewsletterStyle,
  type NewsletterTemplate,
  type NewsletterTemplateSection,
  type StoryKind,
} from "@/lib/newsletter-template";

/** The latest template proposal learned from past issues (GET …/newsletter-template/learn). */
interface Proposal {
  id: string;
  status: "pending" | "done" | "failed";
  proposal: NewsletterTemplate | null;
  rationale: string | null;
  issueCount: number;
  error: string | null;
  createdAt: string;
}

/** Story settings context from the template API. */
interface StoryContext {
  /** One-video formats: where each issue's video comes from (sections don't pick stories). */
  singleVideoNote: string | null;
  /** The brand has case studies to draw on (Starter Story). */
  caseStudies: boolean;
}


/** A field label in the side panel. */
function FieldLabel({ text }: { text: string }) {
  return <span className="flex items-center gap-1 text-muted-foreground">{text}</span>;
}

/** What the HubSpot template email still supplies (everything else is designed here). */
function HubspotTemplateNote({ url }: { url: string | null }) {
  return (
    <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
      <Info className="mr-1 inline size-3 align-[-1px]" />
      The email is designed here, end to end, and sent to HubSpot as one block. The HubSpot template email{url ? " " : ""}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary underline">
          (open it <ExternalLink className="size-3" />)
        </a>
      )}{" "}
      only supplies the sender, the lists and the footer (unsubscribe link, address).
    </p>
  );
}

export function NewsletterTemplateSection({ formatId }: { formatId: string }) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.newsletterDrafter;
  const [template, setTemplate] = useState<NewsletterTemplate | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [hubspotUrl, setHubspotUrl] = useState<string | null>(null);
  const [storyCtx, setStoryCtx] = useState<StoryContext>({ singleVideoNote: null, caseStudies: false });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The learner's latest proposal, and whether the editor is open on it. */
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [learnError, setLearnError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetch(`/api/formats/${formatId}/newsletter-template/learn`)
      .then((r) => (r.ok ? (r.json() as Promise<{ proposal: Proposal | null }>) : null))
      .then((j) => !cancelled && j && setProposal(j.proposal));
    return () => {
      cancelled = true;
    };
  }, [enabled, formatId]);
  // A pending proposal: poll until the worker is done.
  useEffect(() => {
    if (proposal?.status !== "pending") return;
    return startVisibleInterval(() => {
      void fetch(`/api/formats/${formatId}/newsletter-template/learn`)
        .then((r) => (r.ok ? (r.json() as Promise<{ proposal: Proposal | null }>) : null))
        .then((j) => j && setProposal(j.proposal));
    }, 4000);
  }, [proposal?.status, formatId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/formats/${formatId}/newsletter-template`)
      .then((r) => (r.ok ? (r.json() as Promise<{ template: NewsletterTemplate | null; isDefault: boolean; hubspotTemplateUrl?: string | null } & StoryContext>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setTemplate(j.template);
        setIsDefault(j.isDefault);
        setHubspotUrl(j.hubspotTemplateUrl ?? null);
        setStoryCtx({ singleVideoNote: j.singleVideoNote, caseStudies: j.caseStudies });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, formatId]);

  if (!enabled || !template) return null;

  async function learn() {
    setLearnError(null);
    const r = await fetch(`/api/formats/${formatId}/newsletter-template/learn`, { method: "POST" });
    const j = (await r.json().catch(() => ({}))) as { proposal?: Proposal; error?: string };
    if (!r.ok) return setLearnError(j.error ?? "Couldn't start");
    setProposal(j.proposal ?? null);
  }
  async function discardProposal() {
    await fetch(`/api/formats/${formatId}/newsletter-template/learn`, { method: "DELETE" });
    setProposal(null);
    setReviewing(false);
  }

  async function reset() {
    if (!window.confirm("Reset this format's newsletter template to the built-in default?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/formats/${formatId}/newsletter-template`, { method: "DELETE" });
      const j = (await r.json()) as { template: NewsletterTemplate; isDefault: boolean };
      if (r.ok) {
        setTemplate(j.template);
        setIsDefault(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t px-3 py-4">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted">
          <LayoutTemplate className="size-4 text-muted-foreground" />
        </span>
        <span className="text-sm font-medium">Newsletter template</span>
        <span className="rounded-full bg-pink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-pink-700 dark:bg-pink-900/40 dark:text-pink-200">Beta</span>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[#2563eb]" />
        The email every issue of this format is drafted into. AI writes each section every draft, following the instructions shown in it.
      </p>
      {template.hubspot && <HubspotTemplateNote url={hubspotUrl} />}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="block w-[220px] overflow-hidden rounded-md border bg-white text-left shadow-sm hover:ring-2 hover:ring-primary/40"
        aria-label="Edit newsletter template"
      >
        <EmailPreview template={template} showHints scale={0.33} clipHeight={300} />
      </button>
      <p className="text-xs text-muted-foreground">
        {template.sections.length} sections · {isDefault ? "built-in default" : "custom"}
        {template.learnedFrom ? ` · learned from ${template.learnedFrom} past issues${template.learnedAt ? ` on ${template.learnedAt.slice(0, 10)}` : ""}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setEditing(true)}>
          <Pencil /> Edit template
        </Button>
        {(proposal?.status === "pending" ? (
            <Button size="sm" variant="outline" disabled>
              <Loader2 className="animate-spin" /> Reading {proposal.issueCount || "past"} issues…
            </Button>
          ) : proposal?.status === "done" && proposal.proposal ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setReviewing(true)} title="A template learned from the past issues — review it, then save or discard">
                <GraduationCap /> Review learned template
              </Button>
              <Button size="sm" variant="ghost" onClick={discardProposal}>
                Discard
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={learn}
              title="Read this newsletter's past issues (the sent ones, pulled from HubSpot / beehiiv) and propose the template that fits them: sections, instructions, how it reads"
            >
              <GraduationCap /> Learn from past issues
            </Button>
          ))}
        {!isDefault && (
          <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
            <RotateCcw /> Reset to default
          </Button>
        )}
      </div>
      {proposal?.status === "failed" && (
        <p className="rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
          Learning failed: {proposal.error} <button type="button" className="underline" onClick={discardProposal}>Dismiss</button>
        </p>
      )}
      {learnError && <p className="text-xs text-destructive">{learnError}</p>}
      {editing && (
        <TemplateEditorDialog
          formatId={formatId}
          initial={template}
          storyCtx={storyCtx}
          hubspotUrl={hubspotUrl}
          onClose={() => setEditing(false)}
          onSaved={(t) => {
            setTemplate(t);
            setIsDefault(false);
            setEditing(false);
          }}
        />
      )}
      {reviewing && proposal?.proposal && (
        <TemplateEditorDialog
          formatId={formatId}
          initial={proposal.proposal}
          proposalNote={`Learned from ${proposal.issueCount} past issues. ${proposal.rationale ?? ""}`.trim()}
          storyCtx={storyCtx}
          hubspotUrl={hubspotUrl}
          onClose={() => setReviewing(false)}
          onSaved={(t) => {
            setTemplate(t);
            setIsDefault(false);
            setReviewing(false);
            void discardProposal();
          }}
        />
      )}
    </div>
  );
}

export function TemplateEditorDialog({
  formatId,
  initial,
  proposalNote,
  storyCtx,
  hubspotUrl,
  onClose,
  onSaved,
}: {
  formatId: string;
  initial: NewsletterTemplate;
  /** Reviewing a learned proposal: the banner's text; Save template applies it. */
  proposalNote?: string | null;
  storyCtx: StoryContext;
  /** Kept for callers; templates have no locks any more. */
 
  hubspotUrl: string | null;
  onClose: () => void;
  onSaved: (t: NewsletterTemplate) => void;
}) {
  const [t, setT] = useState<NewsletterTemplate>(initial);
  /** The design: the layout document the canvas edits (every template, HubSpot and beehiiv alike). */
  const [design, setDesign] = useState<LayoutDoc>(() => layoutFor(initial));
  const [designTouched, setDesignTouched] = useState(false);
  const layoutEditor = useRef<Editor | null>(null);
  /** Canvas selection: a section key, `look`, or null (the overview). */
  const [selected, setSelected] = useState<string | null>(null);
  /** The canvas width: a desktop client or a phone. */
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !!proposalNote || designTouched || JSON.stringify(t) !== JSON.stringify(initial);
  const sectionIndex = (key: string) => t.sections.findIndex((s) => s.key === key);
  const setSec = (i: number, patch: Partial<NewsletterTemplateSection>) => setT({ ...t, sections: t.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/formats/${formatId}/newsletter-template`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: { ...withLayout(t, design), locked: false } }),
      });
      const j = (await r.json().catch(() => ({}))) as { template?: NewsletterTemplate; error?: string };
      if (!r.ok || !j.template) throw new Error(j.error ?? "Couldn't save");
      onSaved(j.template);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selSection = selected && selected !== "look" ? t.sections.find((s) => s.key === selected) : undefined;
  const deselect = () => setSelected(null);
  const st = t.style;
  const width = device === "mobile" ? 390 : 600;

  return (
    <Dialog open onOpenChange={(o) => !o && (!dirty || window.confirm("Discard your template changes?")) && onClose()}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1500px,97vw)]">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b px-5 py-3">
          <DialogTitle className="truncate text-base font-semibold">{proposalNote ? "Review the learned template" : "Edit newsletter template"}</DialogTitle>
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
                onClick={() => setDevice(d)}
                className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors", device === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pr-8">
            {error && <span className="max-w-md truncate text-xs text-destructive" title={error}>{error}</span>}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" />}
              {proposalNote ? "Save as the template" : "Save template"}
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-h-0 overflow-y-auto" style={{ background: device === "mobile" ? undefined : st.pageBackground }}>
            <div className={cn("mx-auto py-6", device === "mobile" ? "flex justify-center" : "px-5")} style={{ maxWidth: width + 80 }}>
              <div
                className={cn(device === "mobile" && "overflow-hidden rounded-[32px] border-[10px] border-[#1f2937] shadow-xl")}
                style={device === "mobile" ? { width: width + 20, background: st.pageBackground } : undefined}
              >
                <div
                  className={cn(device === "desktop" && "rounded-xl")}
                  style={{
                    ...(bodyStyle(st) as React.CSSProperties),
                    ...(device === "mobile" ? { padding: "16px 14px 20px" } : {}),
                    background: st.contentBackground,
                    ["--nl-link" as string]: st.linkColor,
                    ["--nl-heading" as string]: st.headingColor,
                    ["--nl-heading-font" as string]: st.headingFont ?? st.fontFamily,
                    ["--nl-heading-weight" as string]: String(st.headingWeight),
                    ["--nl-button" as string]: st.buttonColor ?? st.linkColor,
                  }}
                >
                  <LayoutEditor
                    layout={design}
                    sections={t.sections}
                    selected={selSection?.key ?? null}
                    editorRef={layoutEditor}
                    onChange={(l) => {
                      setDesign(l);
                      setDesignTouched(true);
                      setT((cur) => withLayout(cur, l));
                    }}
                    onSelectSlot={(key) => setSelected(key)}
                    onAddSlot={() => {
                      const key = newSlotKey(t);
                      setT((cur) => ({ ...cur, sections: [...cur.sections, defaultSection(key)] }));
                      setSelected(key);
                      return key;
                    }}
                  />
                </div>
              </div>
            </div>
            <p className="flex items-center justify-center gap-1.5 px-5 pb-6 text-center text-xs text-muted-foreground">
              <MousePointerClick className="size-3.5" /> This is the email: design it right here. Click an AI section to edit what the drafter writes there · hover a block for + and ⋮
              {t.hubspot ? " · HubSpot adds the footer when it sends" : ""}
            </p>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l p-4">
            {proposalNote && (
              <p className="flex items-start gap-2 rounded-md bg-[#eef6ff] p-3 text-xs leading-relaxed text-[#1e40af] dark:bg-blue-900/20 dark:text-blue-200">
                <GraduationCap className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">Proposed from the past issues.</span> {proposalNote} Edit anything, then save to make it the template; the drafter then follows it and reads the style notes.
                </span>
              </p>
            )}
            {t.hubspot && <HubspotTemplateNote url={hubspotUrl} />}
            {selected && (
              <button type="button" onClick={deselect} className="self-start text-xs text-muted-foreground hover:text-foreground">
                ← Whole template
              </button>
            )}
            {selSection ? (
              <SectionPanel
                key={selSection.key}
                template={t}
                sec={selSection}
                storyCtx={storyCtx}
                onChange={(patch) => setSec(sectionIndex(selSection.key), patch)}
                onDelete={() => {
                  if (layoutEditor.current) removeSlot(layoutEditor.current, selSection.key);
                  deselect();
                }}
              />
            ) : selected === "look" ? (
              <LookPanel template={t} onChange={setT} />
            ) : (
              <OverviewPanel
                template={t}
                storyCtx={storyCtx}
                onAddSection={() => {
                  const ed = layoutEditor.current;
                  if (!ed) return;
                  // The new AI section goes at the end of the email.
                  const key = newSlotKey(t);
                  setT((cur) => ({ ...cur, sections: [...cur.sections, defaultSection(key)] }));
                  ed.chain().insertContentAt(ed.state.doc.content.size, { type: "slot", attrs: { key } }).run();
                  setSelected(key);
                }}
                onLook={() => setSelected("look")}
                onStyleNotes={(styleNotes) => setT({ ...t, styleNotes })}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-medium">{children}</span>;
}

/** Nothing selected: how the template works, style notes, adding an AI section, the look. */
function OverviewPanel({
  template: t,
  storyCtx,
  onAddSection,
  onLook,
  onStyleNotes,
}: {
  template: NewsletterTemplate;
  storyCtx: StoryContext;
  onAddSection: () => void;
  onLook: () => void;
  onStyleNotes: (notes: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PanelTitle>Whole template</PanelTitle>
      <label className="flex flex-col gap-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="size-3 text-[#2563eb]" /> How this newsletter reads
          {t.learnedFrom ? <span className="text-[10px]">· learned from {t.learnedFrom} issues</span> : null}
        </span>
        <Textarea
          className="min-h-28 text-xs"
          placeholder="Voice, rhythm, how issues open and close, subject-line habits, what varies issue to issue. The drafter reads this with the Skill. “Learn from past issues” on the format page writes it from the sent issues."
          value={t.styleNotes ?? ""}
          onChange={(e) => onStyleNotes(e.target.value || null)}
        />
      </label>
      <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        The canvas is the email. Type, click and restyle anything: images, headings and labels (colors, pills), boxes (fill, border), buttons, dividers, fixed text. Each <span className="font-medium text-[#2563eb]">AI section</span> is where the drafter writes every issue — click one for its instructions. Use the + handle or the toolbar to add blocks anywhere.
      </p>
      <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        {storyCtx.singleVideoNote ??
          "Each section's Story setting says where the drafter looks for it (this week's newest videos, case studies, a recent video…); its instructions say what to pick and how to write it. It's the usual shape, not a quota, and a story this newsletter ran in the last 3 weeks is never reused."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onAddSection}>
          <Plus /> AI section
        </Button>
        <Button size="sm" variant="ghost" onClick={onLook}>
          <Palette /> Look (colors, fonts)
        </Button>
      </div>
    </div>
  );
}

/** A section's settings: name, key, type, story, screenshots, instructions, order. */
function SectionPanel({
  template: t,
  sec,
  storyCtx,
  onChange,
  onDelete,
}: {
  template: NewsletterTemplate;
  sec: NewsletterTemplateSection;
  storyCtx: StoryContext;
  onChange: (patch: Partial<NewsletterTemplateSection>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PanelTitle>{sec.heading || sec.key.replace(/_/g, " ")}</PanelTitle>
        {sec.kind === "sponsor" && <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800">Sponsor</span>}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-[#2563eb]">
        <Sparkles className="mt-0.5 size-3.5 shrink-0" />
        {sec.kind === "sponsor"
          ? "Filled from Asana each issue (the sponsor's copy). These instructions are used when there's no copy yet."
          : "AI writes this section every draft, following these instructions. Edit them here or right in the email."}
      </p>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Instructions: what the drafter picks and writes here</span>
        <Textarea className="min-h-28 text-xs" value={sec.hint} onChange={(e) => onChange({ hint: e.target.value })} />
      </label>
      <p className="rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
          Its look — the heading above it, a pill, a box around it — is designed right in the email. Click the heading to change its text or color.
        </p>
      {sec.kind !== "sponsor" && (
        <label className={cn("flex items-center gap-2 text-xs")}>
          <input type="checkbox" checked={sec.optional} onChange={(e) => onChange({ optional: e.target.checked })} />
          <span>
            Optional
            <span className="block text-muted-foreground">The drafter may leave it out of an issue when there&apos;s nothing worth saying in it.</span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel text="Type" />
          <select
            className="h-8 rounded-md border border-input bg-background px-1 text-xs disabled:opacity-50"
            value={sec.kind}
           
            onChange={(e) => onChange({ kind: e.target.value as "text" | "sponsor" })}
          >
            <option value="text">Written by the drafter</option>
            <option value="sponsor">Sponsor (from Asana)</option>
          </select>
        </label>
      </div>
      {!storyCtx.singleVideoNote && sec.kind !== "sponsor" && (
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel text="Story (where the drafter looks)" />
          <select
            className="h-8 rounded-md border border-input bg-background px-1 text-xs disabled:opacity-50"
            value={sec.story ?? "none"}
           
            onChange={(e) => onChange({ story: e.target.value as StoryKind })}
          >
            {STORY_KINDS.filter((k) => storyCtx.caseStudies || (k !== "case_study" && k !== "any")).map((k) => (
              <option key={k} value={k}>
                {STORY_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      {sec.kind !== "sponsor" && (
        <label className={cn("flex items-start gap-2 text-xs")}>
          <input type="checkbox" className="mt-0.5" checked={sec.screenshots} onChange={(e) => onChange({ screenshots: e.target.checked })} />
          <span>
            <FieldLabel text="Screenshots from the video" />
            <span className="block text-muted-foreground">
              Turn on, then Save template. From the next draft on, AI puts screenshot spots in this section at the right moments in the video and Hub &amp;
              Spoke fills each with that frame. You&apos;ll see them in the draft editor (swap, upload or remove any of them), and they go into the email
              when you push it. The dashed box in the preview shows where they go.
            </span>
          </span>
        </label>
      )}
      {sec.kind !== "sponsor" && (
        <label className={cn("flex items-start gap-2 text-xs")}>
          <input type="checkbox" className="mt-0.5" checked={sec.thumbnail} onChange={(e) => onChange({ thumbnail: e.target.checked })} />
          <span>
            <FieldLabel text="Video thumbnail in this section" />
            <span className="block text-muted-foreground">
              AI places the video&apos;s thumbnail where the instructions say (the issue&apos;s video, or this section&apos;s story video in a roundup). In the
              draft editor it&apos;s an image block: click it to upload your own, use a frame from the video, or remove it.
            </span>
          </span>
        </label>
      )}
      <Button size="sm" variant="ghost" className="self-start text-destructive" onClick={onDelete} disabled={t.sections.length === 1}>
          <Trash2 /> Remove this AI section from the email
        </Button>
    </div>
  );
}

/** A hex color: swatch + text field. */
function HexField({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  return (
    <label className={cn("flex items-center gap-2 text-xs", disabled && "opacity-60")}>
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <input type="color" className="h-7 w-9 cursor-pointer rounded border" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <Input className="h-7 w-24 font-mono text-xs" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The email's look: colors and fonts (everything else is designed on the canvas). */
function LookPanel({ template: t, onChange }: { template: NewsletterTemplate; onChange: (t: NewsletterTemplate) => void }) {
  const st = t.style;
  const setStyle = (patch: Partial<NewsletterStyle>) => onChange({ ...t, style: { ...st, ...patch } });
  return (
    <div className="flex flex-col gap-3">
      <PanelTitle>Look</PanelTitle>
      <p className="text-xs text-muted-foreground">The email&apos;s colors and fonts. Images, headings, labels, boxes and dividers are designed right on the canvas.</p>
      <HexField label="Page" value={st.pageBackground} onChange={(v) => setStyle({ pageBackground: v })} />
      <HexField label="Email" value={st.contentBackground} onChange={(v) => setStyle({ contentBackground: v })} />
      <HexField label="Text" value={st.textColor} onChange={(v) => setStyle({ textColor: v })} />
      <HexField label="Headings" value={st.headingColor} onChange={(v) => setStyle({ headingColor: v })} />
      <HexField label="Links, labels" value={st.linkColor} onChange={(v) => setStyle({ linkColor: v })} />
      <HexField label="Buttons" value={st.buttonColor ?? st.linkColor} onChange={(v) => setStyle({ buttonColor: v })} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Body font</span>
        <Input className="h-8 text-xs" value={st.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Heading font (empty = the body font)</span>
        <Input className="h-8 text-xs" value={st.headingFont ?? ""} placeholder={st.fontFamily} onChange={(e) => setStyle({ headingFont: e.target.value || null })} />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Title weight</span>
        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={st.headingWeight} onChange={(e) => setStyle({ headingWeight: Number(e.target.value) })}>
          {[
            [400, "Regular"],
            [500, "Medium"],
            [600, "Semibold"],
            [700, "Bold"],
            [800, "Extra bold"],
          ].map(([w, l]) => (
            <option key={w} value={w}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-muted-foreground">Fonts fall back to the next in the list where a mail app doesn&apos;t have the first (Gmail and Outlook usually show Helvetica / Arial).</p>
    </div>
  );
}
