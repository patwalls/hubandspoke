"use client";

/**
 * The format page's "Templates" block (flag-gated): the format's DESIGN
 * template (image/carousel formats — what the design editor fills per post)
 * and its CLIP LOOK (video formats — what new clip edits start from; a
 * Descript pack, in our terms). Both are owned by the format, edited with
 * the real editors, and shown here as what they are: a filmstrip of pages,
 * a summary of the look.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ClapperboardIcon, LayoutTemplateIcon, Loader2Icon, PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FONTS } from "@/lib/clip-editor/fonts";
import type { ClipLook } from "@/lib/clip-editor/doc";
import type { DesignDoc } from "@/lib/design-editor/doc";
import { DESIGN_PRESETS, type DesignPresetId } from "@/lib/design-editor/templates";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { DesignTemplateDialog } from "./design-editor-dialog";
import { PageCanvas } from "./page-canvas";
import { DesignStoreContext, createDesignStore } from "./store";
import { invalidateDesignTemplates } from "./use-design-templates";

interface TemplateResponse {
  template: { doc: DesignDoc; source: "stored" | "preset"; updatedAt: string | null } | null;
  imageUrls?: Record<string, string>;
}

export function FormatTemplatesSection({ brand, formatId, formatName, isClippableFormat }: { brand: string; formatId: string; formatName: string; isClippableFormat: boolean }) {
  const flags = useFeatureFlags();
  if (!flags?.designEditor && !flags?.clipEditor) return null;
  // A video format gets a clip look; an image/carousel format gets a design
  // template. Neither card is shown for the other kind.
  const card = isClippableFormat
    ? flags.clipEditor && <ClipLookCard formatId={formatId} />
    : flags.designEditor && <DesignTemplateCard brand={brand} formatId={formatId} formatName={formatName} />;
  if (!card) return null;
  return <div className="grid gap-3">{card}</div>;
}

function DesignTemplateCard({ brand, formatId, formatName }: { brand: string; formatId: string; formatName: string }) {
  const [data, setData] = useState<TemplateResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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
          <Filmstrip doc={t.doc} imageUrls={data.imageUrls ?? {}} />
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
      <DesignTemplateDialog open={editing} onOpenChange={setEditing} formatId={formatId} formatName={formatName} brand={brand} onSaved={() => { invalidateDesignTemplates(); void load(); }} />
    </Card>
  );
}

/** Read-only thumbnails of a template's pages. PageCanvas reads the editor
 *  store even when inert, so give it a throwaway one. */
function Filmstrip({ doc, imageUrls }: { doc: DesignDoc; imageUrls: Record<string, string> }) {
  const [store] = useState(() => createDesignStore({ doc, revision: 0 }));
  useEffect(() => store.getState().replaceDoc(doc, 0), [doc, store]);
  return (
    <DesignStoreContext.Provider value={store}>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {doc.pages.map((p, i) => (
          <div key={p.id} className="relative shrink-0 overflow-hidden rounded border border-border">
            <PageCanvas doc={doc} page={p} pageIndex={i} imageUrls={imageUrls} videoUrl={null} words={[]} scale={96 / doc.canvas.width} interactive={false} showSlots />
            {p.elements.some((e) => e.type === "video") && <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] font-semibold uppercase text-white">video</span>}
          </div>
        ))}
      </div>
    </DesignStoreContext.Provider>
  );
}

function ClipLookCard({ formatId }: { formatId: string }) {
  const [look, setLook] = useState<{ look: ClipLook | null; updatedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/formats/${formatId}/clip-template`);
    if (res.ok) setLook((await res.json()) as { look: ClipLook | null; updatedAt: string | null });
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
    <Card icon={<ClapperboardIcon className="size-3.5" />} title="Clip look" hint="What every new clip edit for this format starts from: fonts, caption style, hook position, how the video sits. Saved from inside the clip editor — the way a Descript pack used to work.">
      {!look ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : l ? (
        <>
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
          <p className="text-[11px] text-muted-foreground">To change it: open any clip of this format in the clip editor, style it, then “Save look as the format’s template”.</p>
          <Button type="button" size="sm" variant="ghost" className="h-7 self-start text-xs" disabled={busy} onClick={() => void remove()}>
            <Trash2Icon className="mr-1 size-3" /> Remove
          </Button>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">No look saved — new edits use the default Reels layout. Open a clip of this format in the clip editor, style it, then “Save look as the format’s template”.</p>
      )}
    </Card>
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
