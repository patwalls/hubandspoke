"use client";

// Format page card: the format's newsletter TEMPLATE shown as the real email
// (each section's instructions where its content goes), plus "Edit template".
// The editor is the same canvas + side panel as the newsletter draft editor
// (EditableSection / FixedPart in the shared previews): click a section in the
// email to edit its instructions in place and see its settings on the right,
// click a card (beehiiv) or the masthead to edit those. Fixed parts owned by
// the email tool stay locked. A `locked` template (Futurepedia's beehiiv one)
// allows instruction edits only, unless a template admin unlocks it; the API
// enforces the same rule. Flag `newsletterDrafter`.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, LayoutTemplate, Loader2, Lock, LockOpen, MousePointerClick, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { EmailPreview } from "@/components/dashboard/email-preview";
import { cn } from "@/lib/utils";
import {
  hubspotOwnedSection,
  STORY_KIND_LABELS,
  STORY_KINDS,
  type BeehiivCard,
  type BeehiivLayout,
  type NewsletterTemplate,
  type NewsletterTemplateSection,
  type StoryKind,
} from "@/lib/newsletter-template";

/** Story settings context from the template API. */
interface StoryContext {
  /** One-video formats: where each issue's video comes from (sections don't pick stories). */
  singleVideoNote: string | null;
  /** The brand has case studies to draw on (Starter Story). */
  caseStudies: boolean;
}

const LOCKED_NOTE = "This template is locked: changes to its structure can break how the email is built. Need an adjustment? Contact Sam.";
/** Hover text on a field a locked template doesn't let you change. */
const FROZEN_WHY = "Locked template: changing this can break how the email builds in beehiiv. Contact Sam if it needs to change.";
/** Hover text on a field the HubSpot template email owns. */
const HUBSPOT_WHY = "Set in the HubSpot template email, so every issue matches. To change it, edit that email in HubSpot (link at the top of this panel) or contact Sam.";

/** A field label with a lock (and why, on hover) when the field can't be changed here. */
function FieldLabel({ text, lock }: { text: string; lock?: string | null }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {text}
      {lock && (
        <span className="group/lock relative inline-flex" title={lock}>
          <Lock className="size-3 text-muted-foreground" />
          <span className="pointer-events-none absolute right-0 top-5 z-20 hidden w-60 rounded-md border bg-popover p-2 text-[11px] leading-snug text-popover-foreground shadow-md group-hover/lock:block">
            {lock}
          </span>
        </span>
      )}
    </span>
  );
}

/** Where the HubSpot-owned parts of the email are changed. */
function HubspotTemplateNote({ url }: { url: string | null }) {
  return (
    <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
      <Lock className="mr-1 inline size-3 align-[-1px]" />
      The masthead, section names and labels, their colors and the footer come from the HubSpot template email, so they&apos;re locked here.
      To change them for every issue, edit that email in HubSpot{url ? " " : ""}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary underline">
          (open it <ExternalLink className="size-3" />)
        </a>
      )}{" "}
      or contact Sam. Here you set what AI writes in each section.
    </p>
  );
}

export function NewsletterTemplateSection({ formatId }: { formatId: string }) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.newsletterDrafter;
  const [template, setTemplate] = useState<NewsletterTemplate | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [canUnlock, setCanUnlock] = useState(false);
  const [hubspotUrl, setHubspotUrl] = useState<string | null>(null);
  const [storyCtx, setStoryCtx] = useState<StoryContext>({ singleVideoNote: null, caseStudies: false });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/formats/${formatId}/newsletter-template`)
      .then((r) => (r.ok ? (r.json() as Promise<{ template: NewsletterTemplate | null; isDefault: boolean; canUnlock?: boolean; hubspotTemplateUrl?: string | null } & StoryContext>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setTemplate(j.template);
        setIsDefault(j.isDefault);
        setCanUnlock(!!j.canUnlock);
        setHubspotUrl(j.hubspotTemplateUrl ?? null);
        setStoryCtx({ singleVideoNote: j.singleVideoNote, caseStudies: j.caseStudies });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, formatId]);

  if (!enabled || !template) return null;

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
        {template.locked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            <Lock className="size-3" /> Locked
          </span>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[#2563eb]" />
        The email every issue of this format is drafted into. AI writes each section every draft, following the instructions shown in it.
      </p>
      {template.locked && <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">{LOCKED_NOTE}</p>}
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
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setEditing(true)}>
          <Pencil /> {template.locked && !canUnlock ? "Edit instructions" : "Edit template"}
        </Button>
        {!isDefault && (!template.locked || canUnlock) && (
          <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
            <RotateCcw /> Reset to default
          </Button>
        )}
      </div>
      {editing && (
        <TemplateEditorDialog
          formatId={formatId}
          initial={template}
          storyCtx={storyCtx}
          canUnlock={canUnlock}
          hubspotUrl={hubspotUrl}
          onClose={() => setEditing(false)}
          onSaved={(t) => {
            setTemplate(t);
            setIsDefault(false);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function TemplateEditorDialog({
  formatId,
  initial,
  storyCtx,
  canUnlock,
  hubspotUrl,
  onClose,
  onSaved,
}: {
  formatId: string;
  initial: NewsletterTemplate;
  storyCtx: StoryContext;
  canUnlock: boolean;
  hubspotUrl: string | null;
  onClose: () => void;
  onSaved: (t: NewsletterTemplate) => void;
}) {
  const [t, setT] = useState<NewsletterTemplate>(initial);
  /** Canvas selection: a section key, `card:<i>`, `look`, or null (the overview). */
  const [selected, setSelected] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  /** A template admin unlocked a locked template for this session (it stays locked when saved). */
  const [unlocked, setUnlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(t) !== JSON.stringify(initial);
  /** Structure can't change: only section instructions can. */
  const frozen = t.locked && !unlocked;
  /** HubSpot-owned section names/colors: admins can change them after unlocking (to match the HubSpot email). */
  const hubspotFrozen = !(canUnlock && unlocked);

  const sectionIndex = (key: string) => t.sections.findIndex((s) => s.key === key);
  const setSec = (i: number, patch: Partial<NewsletterTemplateSection>) => setT({ ...t, sections: t.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setHint = (key: string, hint: string) => setT((cur) => ({ ...cur, sections: cur.sections.map((s) => (s.key === key ? { ...s, hint } : s)) }));
  const setLayout = (layout: BeehiivLayout) => setT({ ...t, beehiiv: { ...t.beehiiv!, layout } });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/formats/${formatId}/newsletter-template`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: t }),
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

  const selSection = selected && !selected.startsWith("card:") && selected !== "look" ? t.sections.find((s) => s.key === selected) : undefined;
  const selCard = selected?.startsWith("card:") ? Number(selected.slice(5)) : null;
  const deselect = () => {
    setSelected(null);
    setEditingSection(null);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && (!dirty || window.confirm("Discard your template changes?")) && onClose()}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1500px,97vw)]">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="text-base font-semibold">Edit newsletter template</DialogTitle>
            {t.locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {frozen ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                {frozen ? "Locked: instructions only" : "Unlocked for this session"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 pr-8">
            {error && <span className="max-w-md text-xs text-destructive">{error}</span>}
            {(t.locked || t.hubspot) && canUnlock && (
              <Button size="sm" variant="ghost" onClick={() => setUnlocked((u) => !u)} title="Template admins can change a locked template's structure">
                {frozen ? <LockOpen /> : <Lock />}
                {frozen ? "Unlock to edit" : "Lock again"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save template
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-h-0 overflow-y-auto bg-muted/40" onClick={deselect}>
            <EmailPreview
              template={t}
              showHints
              edit={{
                mode: "template",
                structureLocked: frozen,
                selected,
                editingSection,
                regenerating: [],
                onSelectSection: (key) => {
                  setSelected(key);
                  setEditingSection(key);
                },
                onChangeSection: setHint,
                onDoneEditing: () => setEditingSection(null),
                onSelectShot: () => {},
                onDropShot: () => {},
                onSelectCard: (i) => {
                  setEditingSection(null);
                  setSelected(`card:${i}`);
                },
                onSelectLook: () => {
                  setEditingSection(null);
                  setSelected("look");
                },
              }}
            />
            <p className="flex items-center justify-center gap-1.5 pb-6 text-center text-xs text-muted-foreground">
              <MousePointerClick className="size-3.5" /> Click a section to edit what the drafter writes there
              {t.beehiiv?.layout ? " · click a card's label or edge for its settings · click the masthead for the look" : ""}
            </p>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l p-4">
            {t.locked && (
              <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                {frozen ? LOCKED_NOTE : "Unlocked: structural changes are allowed for this session. It saves still locked for everyone else."}
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
                index={sectionIndex(selSection.key)}
                storyCtx={storyCtx}
                frozen={frozen}
                hubspotFrozen={hubspotFrozen}
                onChange={(patch) => {
                  const i = sectionIndex(selSection.key);
                  setSec(i, patch);
                  if (patch.key) setSelected(patch.key);
                }}
                onMove={(d) => {
                  const i = sectionIndex(selSection.key);
                  const next = [...t.sections];
                  const [x] = next.splice(i, 1);
                  next.splice(i + d, 0, x);
                  setT({ ...t, sections: next });
                }}
                onDelete={() => {
                  setT({ ...t, sections: t.sections.filter((s) => s.key !== selSection.key) });
                  deselect();
                }}
              />
            ) : selCard != null && t.beehiiv?.layout?.cards[selCard] ? (
              <CardPanel
                key={selCard}
                template={t}
                index={selCard}
                frozen={frozen}
                onChange={setLayout}
                onSelect={(i) => setSelected(i == null ? null : `card:${i}`)}
              />
            ) : selected === "look" ? (
              <LookPanel template={t} frozen={frozen} canLock={canUnlock} onChange={setT} />
            ) : (
              <OverviewPanel
                template={t}
                storyCtx={storyCtx}
                frozen={frozen}
                onAddSection={() => {
                  const key = `section_${t.sections.length + 1}`;
                  setT({ ...t, sections: [...t.sections, { key, heading: "New section", headingLevel: 2, kind: "text", hint: "", pillColor: null, boxColor: null, screenshots: false, look: "text", thumbnail: false, bullets: "list" }] });
                  setSelected(key);
                }}
                onAddCard={() => {
                  const layout = t.beehiiv!.layout;
                  setLayout({ ...layout, cards: [...layout.cards, { label: "New card", border: "#273653", background: "#FFFFFF", sections: [] }] });
                  setSelected(`card:${layout.cards.length}`);
                }}
                onLook={() => setSelected("look")}
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

/** Nothing selected: how the template works, and adding sections / cards. */
function OverviewPanel({
  template: t,
  storyCtx,
  frozen,
  onAddSection,
  onAddCard,
  onLook,
}: {
  template: NewsletterTemplate;
  storyCtx: StoryContext;
  frozen: boolean;
  onAddSection: () => void;
  onAddCard: () => void;
  onLook: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PanelTitle>Whole template</PanelTitle>
      <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        Click any section in the email to edit its instructions right there: what AI writes in it every draft. Its settings show here.
        {t.hubspot ? " The look (masthead, colors, labels, footer) comes from the HubSpot template email; only each section's text is sent to it." : ""}
        {t.beehiiv?.layout ? " Fonts and the footer come from the “Hub & Spoke” template in beehiiv." : ""}
      </p>
      <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        {storyCtx.singleVideoNote ??
          "Each section's Story setting says where the drafter looks for it (this week's newest videos, case studies, a recent video…); its instructions say what to pick and how to write it. It's the usual shape, not a quota, and a story this newsletter ran in the last 3 weeks is never reused."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onAddSection} disabled={frozen}>
          <Plus /> Add section
        </Button>
        {t.beehiiv?.layout && (
          <>
            <Button size="sm" variant="outline" onClick={onAddCard} disabled={frozen}>
              <Plus /> Add card
            </Button>
            <Button size="sm" variant="ghost" onClick={onLook}>
              Look (masthead, colors, poll)
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A section's settings: name, key, type, story, screenshots, instructions, order. */
function SectionPanel({
  template: t,
  sec,
  index,
  storyCtx,
  frozen,
  hubspotFrozen,
  onChange,
  onMove,
  onDelete,
}: {
  template: NewsletterTemplate;
  sec: NewsletterTemplateSection;
  index: number;
  storyCtx: StoryContext;
  frozen: boolean;
  hubspotFrozen: boolean;
  onChange: (patch: Partial<NewsletterTemplateSection>) => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
}) {
  /** The section fills a block in the HubSpot template email (its key is that link; its name and colors live there). */
  const mapped = hubspotOwnedSection(t, sec.key);
  const ownedLock = mapped && hubspotFrozen ? HUBSPOT_WHY : null;
  /** Why a structural field can't change (null: it can). */
  const lock = (owned = false) => (owned && ownedLock) || (frozen ? FROZEN_WHY : null);
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
      <label className="flex flex-col gap-1 text-xs">
        <FieldLabel text="Section name (empty = the section writes its own headline)" lock={lock(true)} />
        <Input className="h-8 text-xs" value={sec.heading ?? ""} disabled={!!lock(true)} onChange={(e) => onChange({ heading: e.target.value || null })} />
      </label>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel text="Key" lock={mapped ? "Links this section to its block in the HubSpot template email, so it can't be renamed." : lock()} />
          <Input className="h-8 w-36 font-mono text-xs" value={sec.key} disabled={mapped || frozen} onChange={(e) => onChange({ key: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel text="Type" lock={lock()} />
          <select
            className="h-8 rounded-md border border-input bg-background px-1 text-xs disabled:opacity-50"
            value={sec.kind}
            disabled={frozen}
            onChange={(e) => onChange({ kind: e.target.value as "text" | "sponsor" })}
          >
            <option value="text">Written by the drafter</option>
            <option value="sponsor">Sponsor (from Asana)</option>
          </select>
        </label>
      </div>
      {!storyCtx.singleVideoNote && sec.kind !== "sponsor" && (
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel text="Story (where the drafter looks)" lock={lock()} />
          <select
            className="h-8 rounded-md border border-input bg-background px-1 text-xs disabled:opacity-50"
            value={sec.story ?? "none"}
            disabled={frozen}
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
        <label className={cn("flex items-start gap-2 text-xs", frozen && "opacity-60")}>
          <input type="checkbox" className="mt-0.5" checked={sec.screenshots} disabled={frozen} onChange={(e) => onChange({ screenshots: e.target.checked })} />
          <span>
            <FieldLabel text="Screenshots from the video" lock={lock()} />
            <span className="block text-muted-foreground">
              Turn on, then Save template. From the next draft on, AI puts screenshot spots in this section at the right moments in the video and Hub &amp;
              Spoke fills each with that frame. You&apos;ll see them in the draft editor (swap, upload or remove any of them), and they go into the email
              when you push it. The dashed box in the preview shows where they go.
            </span>
          </span>
        </label>
      )}
      {sec.kind !== "sponsor" && (
        <label className={cn("flex items-start gap-2 text-xs", frozen && "opacity-60")}>
          <input type="checkbox" className="mt-0.5" checked={sec.thumbnail} disabled={frozen} onChange={(e) => onChange({ thumbnail: e.target.checked })} />
          <span>
            <FieldLabel text="Video thumbnail in this section" lock={lock()} />
            <span className="block text-muted-foreground">
              AI places the video&apos;s thumbnail where the instructions say (the issue&apos;s video, or this section&apos;s story video in a roundup). In the
              draft editor it&apos;s an image block: click it to upload your own, use a frame from the video, or remove it.
            </span>
          </span>
        </label>
      )}
      {t.hubspot && !mapped && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          Not linked to a block in the HubSpot template email yet, so this section is drafted here but won&apos;t appear in the HubSpot draft. Ask to have it
          linked.
        </p>
      )}
      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="ghost" onClick={() => onMove(-1)} disabled={!!lock(true) || index === 0} aria-label="Move up">
          <ArrowUp />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={() => onMove(1)} disabled={!!lock(true) || index === t.sections.length - 1} aria-label="Move down">
          <ArrowDown />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={onDelete} disabled={!!lock(true) || t.sections.length === 1} aria-label="Remove section">
          <Trash2 />
        </Button>
        {lock(true) && <FieldLabel text="" lock={`Order and removal: ${lock(true)}`} />}
      </div>
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

/** The email's look: beehiiv masthead/outro images, colors, the poll; the lock (admins). */
function LookPanel({ template: t, frozen, canLock, onChange }: { template: NewsletterTemplate; frozen: boolean; canLock: boolean; onChange: (t: NewsletterTemplate) => void }) {
  const layout = t.beehiiv?.layout;
  const set = (patch: Partial<BeehiivLayout>) => layout && onChange({ ...t, beehiiv: { ...t.beehiiv!, layout: { ...layout, ...patch } } });
  return (
    <div className="flex flex-col gap-3">
      <PanelTitle>Look</PanelTitle>
      {layout ? (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Masthead image URL</span>
            <Input className="h-8 text-xs" value={layout.mastheadImageUrl ?? ""} disabled={frozen} placeholder="https://… (empty = none)" onChange={(e) => set({ mastheadImageUrl: e.target.value || null })} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Outro image URL</span>
            <Input className="h-8 text-xs" value={layout.outroImageUrl ?? ""} disabled={frozen} placeholder="https://… (empty = none)" onChange={(e) => set({ outroImageUrl: e.target.value || null })} />
          </label>
          <HexField label="Card labels" value={layout.labelColor} disabled={frozen} onChange={(v) => set({ labelColor: v })} />
          <HexField label="Buttons" value={layout.buttonColor} disabled={frozen} onChange={(v) => set({ buttonColor: v })} />
          <label className={cn("flex items-center gap-2 text-xs", frozen && "opacity-60")}>
            <input type="checkbox" checked={layout.poll} disabled={frozen} onChange={(e) => set({ poll: e.target.checked })} />
            <span>&ldquo;How was Futurepedia today?&rdquo; poll after the cards</span>
          </label>
        </>
      ) : (
        <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          The masthead, colors, labels and footer come from the HubSpot template email, so they&apos;re changed there, not here.
        </p>
      )}
      {canLock && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={t.locked} onChange={(e) => onChange({ ...t, locked: e.target.checked })} />
          <span>
            Lock this template
            <span className="block text-muted-foreground">Everyone else can then only edit section instructions (template admins only).</span>
          </span>
        </label>
      )}
    </div>
  );
}

/**
 * A beehiiv card: its label ("{tool} Guide" — {tool} is the tool named in the
 * Why section), border/background, and which sections it holds (a section
 * sits in one card).
 */
function CardPanel({
  template,
  index: i,
  frozen,
  onChange,
  onSelect,
}: {
  template: NewsletterTemplate;
  index: number;
  frozen: boolean;
  onChange: (layout: BeehiivLayout) => void;
  onSelect: (i: number | null) => void;
}) {
  const layout = template.beehiiv!.layout;
  const c = layout.cards[i];
  const set = (patch: Partial<BeehiivLayout>) => onChange({ ...layout, ...patch });
  const setCard = (patch: Partial<BeehiivCard>) => set({ cards: layout.cards.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  /** Put a section in this card (taking it out of any other), or take it out. */
  const toggleSection = (key: string, on: boolean) =>
    set({
      cards: layout.cards.map((x, j) => {
        const rest = x.sections.filter((s) => s.key !== key);
        if (j !== i) return { ...x, sections: on ? rest : x.sections };
        if (!on) return { ...x, sections: rest };
        const order = template.sections.map((s) => s.key);
        const added = [...rest, { key, showHeading: false, linkButtons: false }];
        return { ...x, sections: added.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) };
      }),
    });
  const setSectionOpt = (key: string, patch: { showHeading?: boolean; linkButtons?: boolean }) => setCard({ sections: c.sections.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  const moveCard = (d: -1 | 1) => {
    const next = [...layout.cards];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    set({ cards: next });
    onSelect(i + d);
  };
  const nameOf = (key: string) => template.sections.find((x) => x.key === key)?.heading || key.replace(/_/g, " ");
  const placed = new Set(layout.cards.flatMap((x) => x.sections.map((s) => s.key)));
  const unplaced = template.sections.filter((x) => !placed.has(x.key));

  return (
    <div className="flex flex-col gap-3">
      <PanelTitle>Card: {c.label || "(no label)"}</PanelTitle>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Label (empty = none; {"{tool}"} = the tool named in the Why section)</span>
        <Input className="h-8 text-xs" value={c.label} disabled={frozen} onChange={(e) => setCard({ label: e.target.value })} />
      </label>
      <HexField label="Border" value={c.border} disabled={frozen} onChange={(v) => setCard({ border: v })} />
      <HexField label="Background" value={c.background} disabled={frozen} onChange={(v) => setCard({ background: v })} />
      <div className={cn("flex flex-col gap-1.5 text-xs", frozen && "opacity-60")}>
        <span className="text-muted-foreground">Sections in this card</span>
        {template.sections.map((sec) => {
          const inThis = c.sections.find((x) => x.key === sec.key);
          return (
            <div key={sec.key} className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={!!inThis} disabled={frozen} onChange={(e) => toggleSection(sec.key, e.target.checked)} />
                <span>{nameOf(sec.key)}</span>
              </label>
              {inThis && (
                <div className="ml-5 flex flex-col gap-1 text-muted-foreground">
                  {sec.heading && (
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={inThis.showHeading} disabled={frozen} onChange={(e) => setSectionOpt(sec.key, { showHeading: e.target.checked })} />
                      show its name as a heading
                    </label>
                  )}
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={inThis.linkButtons} disabled={frozen} onChange={(e) => setSectionOpt(sec.key, { linkButtons: e.target.checked })} />
                    links on their own line become buttons
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {unplaced.length > 0 && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          Not in any card: {unplaced.map((x) => nameOf(x.key)).join(", ")}. They&apos;re added in a plain card at the end.
        </p>
      )}
      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="ghost" onClick={() => moveCard(-1)} disabled={frozen || i === 0} aria-label="Move card up">
          <ArrowUp />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={() => moveCard(1)} disabled={frozen || i === layout.cards.length - 1} aria-label="Move card down">
          <ArrowDown />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => {
            set({ cards: layout.cards.filter((_, j) => j !== i) });
            onSelect(null);
          }}
          disabled={frozen || layout.cards.length === 1}
          aria-label="Remove card"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
