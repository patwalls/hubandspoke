"use client";

/**
 * The format page's "Templates" block (flag-gated): the format's DESIGN
 * template (image/carousel formats — what the design editor fills per post)
 * and its CLIP LOOK (video formats — what new clip edits start from; a
 * Descript pack, in our terms). Both are owned by the format, edited with
 * the real editors, and shown here as what they are: a filmstrip of pages,
 * a summary of the look.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ClapperboardIcon, FileUpIcon, LayoutTemplateIcon, Loader2Icon, PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FONTS } from "@/lib/clip-editor/fonts";
import type { AspectRatio, ClipLook } from "@/lib/clip-editor/doc";
import { SAMPLE_WORDS, buildLookPreviewDoc } from "@/lib/clip-editor/look-preview";
import { compileRenderPlan } from "@/lib/clip-editor/plan";
import { resolveScene } from "@/lib/clip-editor/scene";
import { ClipLookDialog } from "@/components/clip-editor/clip-look-dialog";
import { PlaybackEngine } from "@/components/clip-editor/playback-engine";
import { Stage } from "@/components/clip-editor/stage";
import { EditorStoreContext as ClipEditorStoreContext, createEditorStore } from "@/components/clip-editor/store";
import { cn } from "@/lib/utils";
import type { DesignDoc } from "@/lib/design-editor/doc";
import { resolveChannelsInDoc, type ChannelInfo } from "@/lib/design-editor/channel";
import { DESIGN_PRESETS, type DesignPresetId } from "@/lib/design-editor/templates";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { DesignTemplateDialog } from "./design-editor-dialog";
import { PageCanvas } from "./page-canvas";
import { DesignStoreContext, createDesignStore } from "./store";
import { invalidateDesignTemplates } from "./use-design-templates";

interface TemplateResponse {
  template: { doc: DesignDoc; source: "stored" | "preset"; updatedAt: string | null } | null;
  imageUrls?: Record<string, string>;
  channels?: ChannelInfo[];
}

export function FormatTemplatesSection({ brand, formatId, formatName, isClippableFormat }: { brand: string; formatId: string; formatName: string; isClippableFormat: boolean }) {
  const flags = useFeatureFlags();
  if (!flags?.designEditor && !flags?.clipEditor) return null;
  // A video format gets a clip look; an image/carousel format gets a design
  // template. Neither card is shown for the other kind.
  const card = isClippableFormat
    ? flags.clipEditor && <ClipLookCard brand={brand} formatId={formatId} formatName={formatName} />
    : flags.designEditor && <DesignTemplateCard brand={brand} formatId={formatId} formatName={formatName} />;
  if (!card) return null;
  return <div className="grid gap-3">{card}</div>;
}

function DesignTemplateCard({ brand, formatId, formatName }: { brand: string; formatId: string; formatName: string }) {
  const [data, setData] = useState<TemplateResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ImportedDraft | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/formats/${formatId}/design-template`);
    if (res.ok) setData((await res.json()) as TemplateResponse);
  }, [formatId]);
  useEffect(() => {
    void load();
  }, [load]);

  const createFrom = async (preset: DesignPresetId) => {
    setBusy(preset);
    try {
      const res = await fetch(`/api/formats/${formatId}/design-template`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset }) });
      if (!res.ok) return void toast.error("Couldn't create the template");
      invalidateDesignTemplates();
      await load();
      setEditing(true);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    try {
      const res = await fetch(`/api/formats/${formatId}/design-template`, { method: "DELETE" });
      if (!res.ok) return void toast.error("Couldn't remove the template");
      invalidateDesignTemplates();
      await load();
      toast.success("Custom template removed");
    } finally {
      setBusy(null);
    }
  };

  const t = data?.template;
  return (
    <Card icon={<LayoutTemplateIcon className="size-3.5" />} title="Design template" hint="What the design editor fills in for every post of this format. Slots mark what the AI writes, where the founder's photo goes, which slides are video.">
      {!data ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : t ? (
        <>
          <Filmstrip doc={t.doc} imageUrls={data.imageUrls ?? {}} channels={data.channels ?? []} />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t.doc.pages.length} slides · {t.source === "stored" ? `custom${t.updatedAt ? `, updated ${new Date(t.updatedAt).toLocaleDateString()}` : ""}` : "built-in preset (edit to customise)"}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)}>
              <PencilIcon className="mr-1 size-3" /> Edit template
            </Button>
            {t.source === "stored" && (
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={busy !== null} onClick={() => void remove()}>
                <RotateCcwIcon className="mr-1 size-3" /> Reset to preset
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-[12px] text-muted-foreground">No template yet. Start from a preset, then edit it in the design editor.</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(DESIGN_PRESETS) as DesignPresetId[]).map((id) => (
              <Button key={id} type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} title={DESIGN_PRESETS[id].description} onClick={() => void createFrom(id)}>
                {busy === id ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
                {DESIGN_PRESETS[id].label}
              </Button>
            ))}
          </div>
        </>
      )}
      {data && <ImportFromPdf formatId={formatId} hasCustomTemplate={t?.source === "stored"} onOpen={(d) => { setDraft(d); setEditing(true); }} />}
      <DesignTemplateDialog open={editing} onOpenChange={(o) => { setEditing(o); if (!o) setDraft(null); }} formatId={formatId} formatName={formatName} brand={brand} initial={draft} onSaved={() => { invalidateDesignTemplates(); void load(); }} />
    </Card>
  );
}

interface ImportedDraft {
  doc: DesignDoc;
  imageUrls: Record<string, string>;
}

type ImportState =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string }
  | { kind: "reading"; fileName: string; importId: string }
  | { kind: "done"; fileName: string; draft: ImportedDraft; notes: string | null }
  | { kind: "failed"; error: string };

/** "Import from PDF": upload a Canva export, the worker reads it into a
 *  template (design-template-import), open the result in the editor. */
function ImportFromPdf({ formatId, hasCustomTemplate, onOpen }: { formatId: string; hasCustomTemplate: boolean; onOpen: (draft: ImportedDraft) => void }) {
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const importId = state.kind === "reading" ? state.importId : null;
  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/formats/${formatId}/design-template/import/${importId}`).catch(() => null);
      if (cancelled) return;
      const json = res?.ok ? ((await res.json()) as { status: string; error?: string; doc?: DesignDoc; imageUrls?: Record<string, string>; notes?: string | null; fileName?: string | null }) : null;
      if (cancelled) return;
      if (json?.status === "done" && json.doc) {
        setState((s) => ({ kind: "done", fileName: s.kind === "reading" ? s.fileName : json.fileName ?? "PDF", draft: { doc: json.doc!, imageUrls: json.imageUrls ?? {} }, notes: json.notes ?? null }));
      } else if (json?.status === "failed" || (res && !res.ok)) {
        setState({ kind: "failed", error: json?.error ?? "Import failed" });
      } else {
        timer = setTimeout(() => void tick(), 2500);
      }
    };
    let timer = setTimeout(() => void tick(), 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [formatId, importId]);

  const upload = async (file: File) => {
    setState({ kind: "uploading", fileName: file.name });
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`/api/formats/${formatId}/design-template/import`, { method: "POST", body }).catch(() => null);
    const json = res ? ((await res.json().catch(() => ({}))) as { importId?: string; error?: string }) : {};
    if (!res?.ok || !json.importId) return setState({ kind: "failed", error: json.error ?? "Upload failed" });
    setState({ kind: "reading", fileName: file.name, importId: json.importId });
  };

  const busy = state.kind === "uploading" || state.kind === "reading";
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
      <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : <FileUpIcon className="mr-1 size-3" />}
          Import from PDF
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {state.kind === "uploading" ? `Uploading ${state.fileName}…` : state.kind === "reading" ? `Reading ${state.fileName}… (about a minute)` : "Upload a Canva PDF export — the AI rebuilds it as a template you can edit."}
        </span>
      </div>
      {state.kind === "failed" && <p className="text-[11px] text-destructive">{state.error}</p>}
      {state.kind === "done" && (
        <div className="flex flex-col gap-1.5 rounded-md bg-muted/60 p-2 text-[11px]">
          <p>
            Imported <span className="font-medium">{state.fileName}</span> — {state.draft.doc.pages.length} slides.
            {state.notes ? <span className="text-muted-foreground"> {state.notes}</span> : null}
          </p>
          {hasCustomTemplate && <p className="text-amber-700 dark:text-amber-400">Opening it doesn&apos;t change anything yet — your first edit in the editor replaces the current custom template.</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-7 text-xs" onClick={() => onOpen(state.draft)}>
              <PencilIcon className="mr-1 size-3" /> Open in editor
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setState({ kind: "idle" })}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Read-only thumbnails of a template's pages. PageCanvas reads the editor
 *  store even when inert, so give it a throwaway one. */
function Filmstrip({ doc, imageUrls, channels }: { doc: DesignDoc; imageUrls: Record<string, string>; channels: ChannelInfo[] }) {
  const [store] = useState(() => createDesignStore({ doc, revision: 0 }));
  const resolved = useMemo(() => resolveChannelsInDoc(doc, channels), [doc, channels]);
  useEffect(() => store.getState().replaceDoc(doc, 0), [doc, store]);
  return (
    <DesignStoreContext.Provider value={store}>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {doc.pages.map((p, i) => (
          <div key={p.id} className="relative shrink-0 overflow-hidden rounded border border-border">
            <PageCanvas doc={doc} page={p} pageIndex={i} imageUrls={imageUrls} videoUrl={null} words={[]} channels={resolved} scale={96 / doc.canvas.width} interactive={false} showSlots />
            {p.elements.some((e) => e.type === "video") && <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] font-semibold uppercase text-white">video</span>}
          </div>
        ))}
      </div>
    </DesignStoreContext.Provider>
  );
}

function ClipLookCard({ brand, formatId, formatName }: { brand: string; formatId: string; formatName: string }) {
  const [look, setLook] = useState<{ look: ClipLook | null; updatedAt: string | null; aspectRatio: AspectRatio } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/formats/${formatId}/clip-template`);
    if (res.ok) {
      const json = (await res.json()) as { look: ClipLook | null; updatedAt: string | null; aspectRatio?: AspectRatio };
      setLook({ look: json.look, updatedAt: json.updatedAt, aspectRatio: json.aspectRatio ?? "9:16" });
    }
  }, [formatId]);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/formats/${formatId}/clip-template`, { method: "DELETE" });
      if (!res.ok) return void toast.error("Couldn't remove the look");
      await load();
      toast.success("Clip look removed — new edits start from the default layout");
    } finally {
      setBusy(false);
    }
  };
  const l = look?.look;
  const hook = l?.layers.find((x) => x.type === "text" && x.role === "hook");
  const caps = l?.layers.find((x) => x.type === "captions");
  return (
    <Card icon={<ClapperboardIcon className="size-3.5" />} title="Clip look" hint="What every new clip edit for this format starts from: fonts, caption style, hook position, how the video sits — the way a Descript pack used to work. Each clip keeps its own AI-written hook; only the style comes from here.">
      {!look ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <div className="flex items-start gap-4">
            <LookThumbnail key={look.updatedAt ?? "none"} look={l ?? null} aspectRatio={look.aspectRatio} brand={brand} />
            {l ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">Hook</dt>
                <dd>{hook && hook.type === "text" ? `${FONTS[hook.style.fontId].label} · ${hook.style.sizePct.toFixed(1)}% · ${hook.style.color}` : "none"}</dd>
                <dt className="text-muted-foreground">Captions</dt>
                <dd>{caps && caps.type === "captions" ? `${FONTS[caps.style.fontId].label} · ${caps.maxWordsPerCue} words/cue${caps.highlightColor ? ` · highlight ${caps.highlightColor}` : ""}` : "none"}</dd>
                <dt className="text-muted-foreground">Video</dt>
                <dd>{l.video.fit === "cover" ? "fill" : "fit"}{l.video.scalePct !== 100 ? ` · ${l.video.scalePct}%` : ""}{l.video.radiusPct ? ` · rounded ${l.video.radiusPct}%` : ""} · {l.background} background</dd>
                <dt className="text-muted-foreground">Layers</dt>
                <dd>{l.layers.length}{look.updatedAt ? ` · saved ${new Date(look.updatedAt).toLocaleDateString()}` : ""}</dd>
              </dl>
            ) : (
              <p className="text-[12px] text-muted-foreground">No look saved — new edits use the default Reels layout (shown). Create a look to set this format&apos;s fonts, captions and video placement.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)}>
              <PencilIcon className="mr-1 size-3" /> {l ? "Edit look" : "Create look"}
            </Button>
            {l && (
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => void remove()}>
                <Trash2Icon className="mr-1 size-3" /> Remove
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">You can also save a look from inside any clip of this format: clip editor → ⋯ → “Save look as the format’s template”.</p>
          <ClipLookDialog open={editing} onOpenChange={(o) => { setEditing(o); if (!o) void load(); }} formatId={formatId} formatName={formatName} brand={brand} look={l ?? null} aspectRatio={look.aspectRatio} onSaved={() => {}} />
        </>
      )}
    </Card>
  );
}

/** The look on a placeholder, read-only — the card's picture of it. The stage
 *  reads the editor store even when inert, so give it a throwaway one. */
function LookThumbnail({ look, aspectRatio, brand }: { look: ClipLook | null; aspectRatio: AspectRatio; brand: string }) {
  const [store] = useState(() => createEditorStore({ doc: buildLookPreviewDoc(look, aspectRatio), revision: 0 }));
  const [engine] = useState(() => new PlaybackEngine());
  const doc = store.getState().doc;
  const plan = useMemo(() => compileRenderPlan(doc, SAMPLE_WORDS), [doc]);
  const scene = useMemo(() => resolveScene(plan), [plan]);
  useEffect(() => {
    engine.setPlan(plan);
    engine.seek(1);
  }, [engine, plan]);
  const vertical = doc.canvas.height > doc.canvas.width;
  return (
    <div className={cn("pointer-events-none relative shrink-0 overflow-hidden rounded border border-border bg-muted", vertical ? "h-[214px] w-[120px]" : "h-[120px] w-[214px]")} aria-hidden>
      <ClipEditorStoreContext.Provider value={store}>
        <Stage plan={plan} scene={scene} engine={engine} videoUrl={null} brand={brand} variant="preview" />
      </ClipEditorStoreContext.Provider>
    </div>
  );
}

function Card({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-pink-800 dark:bg-pink-950 dark:text-pink-300">beta</span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}
