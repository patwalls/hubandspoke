"use client";

// Format page card: the format's newsletter TEMPLATE shown as the real email
// (a thumbnail rendered by renderEmailHtml, with each section's hint where
// its content goes), plus "Edit template" — a full-screen editor with the
// look (masthead, font, colors) and the sections (headings, pills, sponsor
// box, what the drafter writes) on the left and the live email on the right.
// Mirrors the design editor's template card. Flag `newsletterDrafter`;
// renders nothing without it or for formats with no newsletter template.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, LayoutTemplate, Loader2, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { EmailPreview } from "@/components/dashboard/email-preview";
import { STORY_KIND_LABELS, STORY_KINDS, type NewsletterTemplate, type NewsletterTemplateSection, type StoryKind } from "@/lib/newsletter-template";

/** Story settings context from the template API. */
interface StoryContext {
  /** One-video formats: where each issue's video comes from (sections don't pick stories). */
  singleVideoNote: string | null;
  /** The brand has case studies to draw on (Starter Story). */
  caseStudies: boolean;
}

export function NewsletterTemplateSection({ formatId }: { formatId: string }) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.newsletterDrafter;
  const [template, setTemplate] = useState<NewsletterTemplate | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [storyCtx, setStoryCtx] = useState<StoryContext>({ singleVideoNote: null, caseStudies: false });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/formats/${formatId}/newsletter-template`)
      .then((r) => (r.ok ? (r.json() as Promise<{ template: NewsletterTemplate | null; isDefault: boolean } & StoryContext>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setTemplate(j.template);
        setIsDefault(j.isDefault);
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
      </div>
      <p className="text-xs text-muted-foreground">
        The email every issue of this format is drafted into. Each section shows what the drafter writes there.
      </p>
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
          <Pencil /> Edit template
        </Button>
        {!isDefault && (
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

function ColorField({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <input type="color" className="h-7 w-9 cursor-pointer rounded border" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value)} />
      <Input className="h-7 w-24 font-mono text-xs" value={value ?? ""} placeholder={allowNone ? "none" : ""} onChange={(e) => onChange(e.target.value || (allowNone ? null : "#000000"))} />
      {allowNone && value && (
        <button type="button" className="text-muted-foreground underline" onClick={() => onChange(null)}>
          none
        </button>
      )}
    </label>
  );
}

function TemplateEditorDialog({
  formatId,
  initial,
  storyCtx,
  onClose,
  onSaved,
}: {
  formatId: string;
  initial: NewsletterTemplate;
  storyCtx: StoryContext;
  onClose: () => void;
  onSaved: (t: NewsletterTemplate) => void;
}) {
  const [t, setT] = useState<NewsletterTemplate>(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(t) !== JSON.stringify(initial);

  const setStyle = (patch: Partial<NewsletterTemplate["style"]>) => setT({ ...t, style: { ...t.style, ...patch } });
  const setSec = (i: number, patch: Partial<NewsletterTemplateSection>) => setT({ ...t, sections: t.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const next = [...t.sections];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    setT({ ...t, sections: next });
    setOpen(i + d);
  };

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

  return (
    <Dialog open onOpenChange={(o) => !o && (!dirty || window.confirm("Discard your template changes?")) && onClose()}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1400px,97vw)]">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <DialogTitle className="text-base font-semibold">Edit newsletter template</DialogTitle>
          <div className="flex items-center gap-2 pr-8">
            {error && <span className="max-w-md text-xs text-destructive">{error}</span>}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save template
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r p-5">
            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">Look</span>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Masthead image URL</span>
                <Input className="h-8 text-xs" value={t.style.mastheadImageUrl ?? ""} placeholder="https://… (empty = no masthead)" onChange={(e) => setStyle({ mastheadImageUrl: e.target.value || null })} />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Masthead link</span>
                <Input className="h-8 text-xs" value={t.style.mastheadLinkUrl ?? ""} placeholder="https://…" onChange={(e) => setStyle({ mastheadLinkUrl: e.target.value || null })} />
              </label>
              <ColorField label="Masthead background" value={t.style.mastheadBackground} allowNone onChange={(v) => setStyle({ mastheadBackground: v })} />
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Font</span>
                <Input className="h-8 text-xs" value={t.style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })} />
              </label>
              <ColorField label="Text" value={t.style.textColor} onChange={(v) => setStyle({ textColor: v ?? "#616161" })} />
              <ColorField label="Headings" value={t.style.headingColor} onChange={(v) => setStyle({ headingColor: v ?? "#030212" })} />
              <ColorField label="Links" value={t.style.linkColor} onChange={(v) => setStyle({ linkColor: v ?? "#197bbd" })} />
              <ColorField label="Page background" value={t.style.pageBackground} onChange={(v) => setStyle({ pageBackground: v ?? "#f4f4f5" })} />
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={t.style.dividers} onChange={(e) => setStyle({ dividers: e.target.checked })} />
                <span>Dividers between sections</span>
              </label>
            </section>

            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">Sections</span>
              <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                {storyCtx.singleVideoNote ??
                  "Each section's Story setting says where the drafter looks for it (this week's newest videos, case studies, a recent video…); its instructions say what to pick and how to write it. It's the usual shape, not a quota, and a story this newsletter ran in the last 3 weeks is never reused."}
              </p>
              {t.sections.map((sec, i) => (
                <div key={i} className="rounded-md border">
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    {sec.pillColor && <span className="size-3 rounded-sm" style={{ background: sec.pillColor }} />}
                    <span className="flex-1 truncate">{sec.heading || <span className="text-muted-foreground">{sec.key.replace(/_/g, " ")} (no heading)</span>}</span>
                    {sec.kind === "sponsor" && <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800">Sponsor</span>}
                    {!storyCtx.singleVideoNote && sec.kind !== "sponsor" && sec.story && sec.story !== "none" && (
                      <span className="rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">{STORY_KIND_LABELS[sec.story]}</span>
                    )}
                  </button>
                  {open === i && (
                    <div className="flex flex-col gap-2 border-t px-3 py-3">
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">Heading (empty = the section writes its own)</span>
                        <Input className="h-8 text-xs" value={sec.heading ?? ""} onChange={(e) => setSec(i, { heading: e.target.value || null })} />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">Key</span>
                          <Input className="h-8 w-36 font-mono text-xs" value={sec.key} onChange={(e) => setSec(i, { key: e.target.value })} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">Size</span>
                          <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={sec.headingLevel} onChange={(e) => setSec(i, { headingLevel: Number(e.target.value) as 2 | 3 })}>
                            <option value={2}>Large</option>
                            <option value={3}>Small</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">Type</span>
                          <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={sec.kind} onChange={(e) => setSec(i, { kind: e.target.value as "text" | "sponsor" })}>
                            <option value="text">Written by the drafter</option>
                            <option value="sponsor">Sponsor (from Asana)</option>
                          </select>
                        </label>
                      </div>
                      {!storyCtx.singleVideoNote && sec.kind !== "sponsor" && (
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">Story (where the drafter looks)</span>
                          <select
                            className="h-8 rounded-md border border-input bg-background px-1 text-xs"
                            value={sec.story ?? "none"}
                            onChange={(e) => setSec(i, { story: e.target.value as StoryKind })}
                          >
                            {STORY_KINDS.filter((k) => storyCtx.caseStudies || (k !== "case_study" && k !== "any")).map((k) => (
                              <option key={k} value={k}>
                                {STORY_KIND_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <ColorField label="Heading pill" value={sec.pillColor} allowNone onChange={(v) => setSec(i, { pillColor: v })} />
                      <ColorField label="Content box" value={sec.boxColor} allowNone onChange={(v) => setSec(i, { boxColor: v })} />
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">Instructions: what the drafter picks and writes here</span>
                        <Textarea className="min-h-20 text-xs" value={sec.hint} onChange={(e) => setSec(i, { hint: e.target.value })} />
                      </label>
                      <div className="flex items-center gap-1">
                        <Button size="icon-xs" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                          <ArrowUp />
                        </Button>
                        <Button size="icon-xs" variant="ghost" onClick={() => move(i, 1)} disabled={i === t.sections.length - 1} aria-label="Move down">
                          <ArrowDown />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => {
                            setT({ ...t, sections: t.sections.filter((_, j) => j !== i) });
                            setOpen(null);
                          }}
                          disabled={t.sections.length === 1}
                          aria-label="Remove section"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setT({
                    ...t,
                    sections: [...t.sections, { key: `section_${t.sections.length + 1}`, heading: "New section", headingLevel: 2, kind: "text", hint: "", pillColor: null, boxColor: null }],
                  });
                  setOpen(t.sections.length);
                }}
              >
                <Plus /> Add section
              </Button>
            </section>
          </div>
          <div className="min-h-0 overflow-y-auto bg-muted/40">
            <EmailPreview template={t} showHints />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
