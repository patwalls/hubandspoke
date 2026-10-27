"use client";

// The nav's "New" button (flag `newsletterDrafter`): start a piece of content
// from anywhere in the app. The menu lists every kind we make; each kind's
// dialog asks for what it needs — above all the PILLAR content it is made
// from, and the ANGLE (what it's about; the drafts steer by it) — and then
// opens the right editor. Newsletter: brand, newsletter format, its pillar
// content (a video for one-video formats; for roundups, the brand's videos
// and case studies from the last N days, picked by the drafter), angle, send
// date → the newsletter editor. Posts (NEW_POST_KINDS): brand, format,
// pillar video, angle → the design editor (an IG post with a template), the
// clip editor (reels, Shorts, video posts on X) or the post's page, where
// the Draft Algorithm writes the copy (src/lib/services/new-post.ts).

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, Mail, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { cn } from "@/lib/utils";
import { NEW_POST_KINDS, type NewPostKind } from "@/lib/new-post-kinds";

// Lazy, like the Repurposed queue: only a post that opens in an editor
// downloads it.
const DesignEditorDialog = dynamic(
  () => import("@/components/design-editor/design-editor-dialog").then((m) => m.DesignEditorDialog),
  { ssr: false },
);
const ClipEditorDialog = dynamic(
  () => import("@/components/clip-editor/clip-editor-dialog").then((m) => m.ClipEditorDialog),
  { ssr: false },
);

interface BrandOption {
  slug: string;
  label: string;
  disabled?: boolean;
  parent?: string | null;
}

interface FormatOption {
  id: string;
  name: string;
  hasSkill: boolean;
  kind: "roundup" | "single_video";
}

interface VideoOption {
  id: string;
  title: string | null;
  publishedAt: string | null;
  channel?: string;
  usedBySlot?: string | null;
  hasTranscript?: boolean;
}

/** Every kind of content the menu offers, in order — the newsletter, then the
 *  posts — split by a divider; `platform` draws its logo. */
const KIND_GROUPS: { key: "newsletter" | NewPostKind; label: string; platform: string }[][] = [
  [{ key: "newsletter", label: "Newsletter", platform: "newsletter" }],
  NEW_POST_KINDS.map((k) => ({ key: k.key, label: k.label, platform: k.platform })),
];

export function NewContentMenu({
  brands,
  currentBrand,
}: {
  brands: BrandOption[];
  currentBrand: string | null;
}) {
  const flags = useFeatureFlags();
  const [open, setOpen] = useState<"newsletter" | NewPostKind | null>(null);
  if (!flags?.newsletterDrafter) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Create new content"
          data-testid="new-content"
          className="flex h-7 items-center gap-1 rounded-md bg-primary pl-2 pr-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-3.5" />
          <span className="hidden sm:inline">New</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {KIND_GROUPS.map((group, i) => (
            <DropdownMenuGroup key={i}>
              {i > 0 && <DropdownMenuSeparator />}
              {group.map((k) => (
                <DropdownMenuItem
                  key={k.key}
                  onClick={() => setOpen(k.key)}
                  className="cursor-pointer gap-2 whitespace-nowrap"
                  data-testid={`new-content-${k.key}`}
                >
                  <PlatformIcon
                    platform={k.platform}
                    size={15}
                    inheritColor
                    className="text-muted-foreground"
                  />
                  <span className="flex-1">{k.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "newsletter" && (
        <NewNewsletterDialog
          brands={brands.filter((b) => b.slug !== "all" && !b.disabled)}
          initialBrand={currentBrand}
          onClose={() => setOpen(null)}
        />
      )}
      {open && open !== "newsletter" && (
        <NewPostFlow
          key={open}
          kind={open}
          brands={brands.filter((b) => b.slug !== "all" && !b.disabled)}
          initialBrand={currentBrand}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Brand → format → pillar content → send date → the newsletter editor. */
function NewNewsletterDialog({
  brands,
  initialBrand,
  onClose,
}: {
  brands: BrandOption[];
  initialBrand: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [brand, setBrand] = useState(
    brands.some((b) => b.slug === initialBrand)
      ? initialBrand!
      : (brands[0]?.slug ?? ""),
  );
  // Loaded per brand / per format: a list for another brand or format means "loading".
  const [formatsFor, setFormatsFor] = useState<{
    brand: string;
    list: FormatOption[];
  } | null>(null);
  const [formatId, setFormatId] = useState("");
  const [videosFor, setVideosFor] = useState<{
    formatId: string;
    list: VideoOption[];
  } | null>(null);
  const [sourceItemId, setSourceItemId] = useState("");
  /** Roundup formats: the issue is about one piece of pillar content, or a roundup the drafter assembles. */
  const [mode, setMode] = useState<"one" | "roundup">("roundup");
  const [brandVideosFor, setBrandVideosFor] = useState<{
    brand: string;
    list: VideoOption[];
  } | null>(null);
  const [days, setDays] = useState(7);
  const [notes, setNotes] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!brand) return;
    let cancelled = false;
    void fetch(`/api/newsletter-drafts?brand=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : { formats: [] }))
      .then((j: { formats: FormatOption[] }) => {
        if (cancelled) return;
        setFormatsFor({ brand, list: j.formats });
        setFormatId(
          j.formats.find((f) => f.hasSkill)?.id ?? j.formats[0]?.id ?? "",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const formats = formatsFor?.brand === brand ? formatsFor.list : null;
  const format = formats?.find((f) => f.id === formatId) ?? null;
  useEffect(() => {
    if (format?.kind !== "single_video") return;
    let cancelled = false;
    void fetch(
      `/api/newsletter-drafts/videos?formatId=${encodeURIComponent(format.id)}`,
    )
      .then((r) => (r.ok ? r.json() : { videos: [] }))
      .then((j: { videos: VideoOption[] }) => {
        if (cancelled) return;
        setVideosFor({ formatId: format.id, list: j.videos });
        setSourceItemId(
          j.videos.find((v) => !v.usedBySlot)?.id ?? j.videos[0]?.id ?? "",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [format?.id, format?.kind]);
  const videos = format && videosFor?.formatId === format.id ? videosFor.list : null;
  // One piece for a roundup format: the brand's recent videos (any channel).
  useEffect(() => {
    if (!brand || format?.kind !== "roundup" || mode !== "one") return;
    let cancelled = false;
    void fetch(`/api/newsletter-drafts/videos?brand=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : { videos: [] }))
      .then((j: { videos: VideoOption[] }) => {
        if (cancelled) return;
        setBrandVideosFor({ brand, list: j.videos });
        setSourceItemId((cur) =>
          j.videos.some((v) => v.id === cur && v.hasTranscript !== false)
            ? cur
            : (j.videos.find((v) => v.hasTranscript !== false)?.id ?? ""),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [brand, format?.kind, mode]);
  const brandVideos = brandVideosFor?.brand === brand ? brandVideosFor.list : null;
  const onePiece = format?.kind === "single_video" || mode === "one";
  const pickList = format?.kind === "single_video" ? videos : brandVideos;

  const ready = !!formatId && (!onePiece || (!!pickList && !!sourceItemId)) && !creating;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/newsletter-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formatId,
          sendDate: sendDate || null,
          notes: notes.trim() || null,
          ...(onePiece ? { sourceItemId } : { days }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !json.id)
        throw new Error(json.error ?? "Couldn't start the draft");
      onClose();
      router.push(`/${brand}/newsletters?open=${json.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  const field =
    "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm";
  return (
    <Dialog open onOpenChange={(o) => !o && !creating && onClose()}>
      <DialogContent className="flex max-w-lg flex-col gap-0 p-0">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Mail className="size-4" />
          </span>
          <div className="flex flex-col">
            <DialogTitle className="text-base font-semibold">
              New newsletter
            </DialogTitle>
            <span className="text-xs text-muted-foreground">
              Pick what it&apos;s made from; the draft writes itself into the
              format&apos;s template.
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {brands.length > 1 && (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Brand
              </span>
              <select
                className={field}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              >
                {brands.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Newsletter
            </span>
            {formats === null ? (
              <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading formats…
              </span>
            ) : formats.length === 0 ? (
              <span className="flex h-9 items-center text-xs text-muted-foreground">
                No newsletter formats for this brand yet.
              </span>
            ) : (
              <select
                className={field}
                value={formatId}
                onChange={(e) => setFormatId(e.target.value)}
              >
                {formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.hasSkill ? "" : " (no Skill yet)"}
                  </option>
                ))}
              </select>
            )}
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Pillar content
              </span>
              {format?.kind === "roundup" && (
                <div
                  className="flex items-center rounded-lg border bg-muted/50 p-0.5 text-xs"
                  role="radiogroup"
                  aria-label="What the issue is about"
                >
                  {(
                    [
                      ["one", "One piece"],
                      ["roundup", "Roundup"],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "rounded-md px-2.5 py-1 font-medium transition-colors",
                        mode === m
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {onePiece ? (
              pickList === null ? (
                <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading videos…
                </span>
              ) : (
                <>
                  <select
                    className={field}
                    value={sourceItemId}
                    onChange={(e) => setSourceItemId(e.target.value)}
                  >
                    {pickList.length === 0 && (
                      <option value="">
                        {format?.kind === "single_video"
                          ? "No recent videos on this format's channels"
                          : "No recent videos for this brand"}
                      </option>
                    )}
                    {pickList.map((v) => (
                      <option key={v.id} value={v.id} disabled={v.hasTranscript === false}>
                        {fmtDate(v.publishedAt)} · {v.channel ? `${v.channel} · ` : ""}
                        {v.title ?? "Untitled"}
                        {v.usedBySlot
                          ? " (already used)"
                          : v.hasTranscript === false
                            ? " (no transcript yet)"
                            : ""}
                      </option>
                    ))}
                  </select>
                  {format?.kind === "roundup" && (
                    <span className="text-xs text-muted-foreground">
                      The whole issue is about this video: every story section takes a different angle on it.
                    </span>
                  )}
                </>
              )
            ) : (
              <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-pink-500" />
                <span>
                  The drafter picks the stories itself: this brand&apos;s videos
                  and case studies published in the last{" "}
                  <select
                    className="mx-0.5 h-6 rounded border border-input bg-background px-1 text-xs text-foreground"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    {[7, 14, 30].map((d) => (
                      <option key={d} value={d}>
                        {d} days
                      </option>
                    ))}
                  </select>
                  , one per section of the template. You can swap any of them in
                  the editor.
                </span>
              </div>
            )}
          </div>

          <AngleField
            value={notes}
            onChange={setNotes}
            placeholder="e.g. Open on how I can't stop thinking about this business, then the why: automated marketing and SEO"
            hint="What this issue is about: a topic, a point to make, a part of the video. The drafter builds the issue around it; leave it blank and it picks."
          />

          <label className="flex w-44 flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Send date
            </span>
            <Input
              type="date"
              className="h-9"
              value={sendDate}
              onChange={(e) => setSendDate(e.target.value)}
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            One Claude run, usually a few minutes.
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={create}
              disabled={!ready}
              data-testid="new-newsletter-create"
            >
              {creating ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Create &amp; draft
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The ANGLE: what the piece is about, in the editor's words. Its own full
 *  row — the drafts treat it as the brief. */
function AngleField({
  value,
  onChange,
  placeholder,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hint: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">
        Angle <span className="font-normal">(optional)</span>
      </span>
      <Textarea
        className="min-h-20 text-sm"
        rows={3}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="new-content-angle"
      />
      <span className="text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

interface PostFormatOption {
  id: string;
  name: string;
  editor: "design" | "clip" | "post";
}

interface PillarOption {
  id: string;
  title: string | null;
  publishedAt: string | null;
  hasTranscript: boolean;
  hasVideo: boolean;
}

const EDITOR_LINE: Record<PostFormatOption["editor"], string> = {
  design: "Opens in the design editor, drafted from the video.",
  clip: "Opens in the clip editor on the moment AI picks.",
  post: "Opens the post with its copy drafted.",
};

/** A new post: the dialog, then the editor it opens in. */
function NewPostFlow({
  kind,
  brands,
  initialBrand,
  onClose,
}: {
  kind: NewPostKind;
  brands: BrandOption[];
  initialBrand: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState<{
    brand: string;
    editor: "design" | "clip";
    productionItemId: string;
    clipIdeaId?: string;
  } | null>(null);
  const toPost = (brand: string, id: string) => {
    onClose();
    router.push(`/${brand}/content/${id}`);
  };
  if (opened?.editor === "design") {
    return (
      <DesignEditorDialog
        open
        onOpenChange={(o) => !o && onClose()}
        productionItemId={opened.productionItemId}
        brand={opened.brand}
        onDone={() => router.refresh()}
        onUnsupported={() => toPost(opened.brand, opened.productionItemId)}
      />
    );
  }
  if (opened?.editor === "clip" && opened.clipIdeaId) {
    return (
      <ClipEditorDialog
        open
        onOpenChange={(o) => !o && onClose()}
        clipIdeaId={opened.clipIdeaId}
        brand={opened.brand}
        onDone={() => router.refresh()}
        onUnsupported={() => toPost(opened.brand, opened.productionItemId)}
      />
    );
  }
  return (
    <NewPostDialog
      kind={kind}
      brands={brands}
      initialBrand={initialBrand}
      onClose={onClose}
      onCreated={(brand, r) => {
        if (r.editor === "post") return toPost(brand, r.productionItemId);
        setOpened({ brand, editor: r.editor, productionItemId: r.productionItemId, clipIdeaId: r.clipIdeaId });
      }}
    />
  );
}

/** Brand → format → pillar video → angle → create. */
function NewPostDialog({
  kind,
  brands,
  initialBrand,
  onClose,
  onCreated,
}: {
  kind: NewPostKind;
  brands: BrandOption[];
  initialBrand: string | null;
  onClose: () => void;
  onCreated: (
    brand: string,
    r: { editor: PostFormatOption["editor"]; productionItemId: string; clipIdeaId?: string },
  ) => void;
}) {
  const meta = NEW_POST_KINDS.find((k) => k.key === kind)!;
  const [brand, setBrand] = useState(
    brands.some((b) => b.slug === initialBrand)
      ? initialBrand!
      : (brands[0]?.slug ?? ""),
  );
  // Loaded per brand: options for another brand mean "loading".
  const [optionsFor, setOptionsFor] = useState<{
    brand: string;
    formats: PostFormatOption[];
    pillars: PillarOption[];
  } | null>(null);
  const [formatId, setFormatId] = useState("");
  const [pickedPillarId, setPillarId] = useState("");
  const [angle, setAngle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!brand) return;
    let cancelled = false;
    void fetch(
      `/api/new-post?brand=${encodeURIComponent(brand)}&kind=${encodeURIComponent(kind)}`,
    )
      .then((r) => (r.ok ? r.json() : { formats: [], pillars: [] }))
      .then((j: { formats: PostFormatOption[]; pillars: PillarOption[] }) => {
        if (cancelled) return;
        setOptionsFor({ brand, formats: j.formats, pillars: j.pillars });
        setFormatId(j.formats[0]?.id ?? "");
      });
    return () => {
      cancelled = true;
    };
  }, [brand, kind]);

  const options = optionsFor?.brand === brand ? optionsFor : null;
  const format = options?.formats.find((f) => f.id === formatId) ?? null;
  // No format: reels and Shorts still go to the clip editor (the server
  // decides; this only shapes the hint and which videos are pickable).
  const short = meta.postType === "instagram_reel" || meta.postType === "youtube_shorts";
  const editor: PostFormatOption["editor"] = format?.editor ?? (short ? "clip" : "post");
  const usable = (p: PillarOption) =>
    p.hasTranscript && (editor !== "clip" || p.hasVideo);
  // The pick, unless the format change made it unusable: then the newest usable video.
  const pillarId =
    options?.pillars.some((p) => p.id === pickedPillarId && usable(p))
      ? pickedPillarId
      : (options?.pillars.find(usable)?.id ?? "");

  const ready = !!options && !!pillarId && !creating;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/new-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          brand,
          formatId: formatId || null,
          pillarId,
          angle: angle.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        editor?: PostFormatOption["editor"];
        productionItemId?: string;
        clipIdeaId?: string;
        error?: string;
      };
      if (!res.ok || !json.productionItemId || !json.editor)
        throw new Error(json.error ?? "Couldn't create the post");
      onCreated(brand, {
        editor: json.editor,
        productionItemId: json.productionItemId,
        clipIdeaId: json.clipIdeaId,
      });
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  const field =
    "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm";
  return (
    <Dialog open onOpenChange={(o) => !o && !creating && onClose()}>
      <DialogContent className="flex max-w-lg flex-col gap-0 p-0">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <PlatformIcon platform={meta.platform} size={16} inheritColor />
          </span>
          <div className="flex flex-col">
            <DialogTitle className="text-base font-semibold">
              New {meta.label}
            </DialogTitle>
            <span className="text-xs text-muted-foreground">
              Pick the video it&apos;s made from and what it&apos;s about; the
              draft follows the format.
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {brands.length > 1 && (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Brand
              </span>
              <select
                className={field}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              >
                {brands.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Format
            </span>
            {options === null ? (
              <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading formats…
              </span>
            ) : (
              <select
                className={field}
                value={formatId}
                onChange={(e) => setFormatId(e.target.value)}
                data-testid="new-post-format"
              >
                {options.formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
                <option value="">
                  {options.formats.length === 0
                    ? `No ${meta.label} format for this brand yet — platform defaults`
                    : "No format — platform defaults"}
                </option>
              </select>
            )}
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Pillar content
            </span>
            {options === null ? (
              <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading videos…
              </span>
            ) : (
              <select
                className={field}
                value={pillarId}
                onChange={(e) => setPillarId(e.target.value)}
                data-testid="new-post-pillar"
              >
                {options.pillars.length === 0 && (
                  <option value="">No recent videos for this brand</option>
                )}
                {options.pillars.map((p) => (
                  <option key={p.id} value={p.id} disabled={!usable(p)}>
                    {fmtDate(p.publishedAt)} · {p.title ?? "Untitled"}
                    {!p.hasTranscript
                      ? " (no transcript yet)"
                      : editor === "clip" && !p.hasVideo
                        ? " (not archived yet)"
                        : ""}
                  </option>
                ))}
              </select>
            )}
          </label>

          <AngleField
            value={angle}
            onChange={setAngle}
            placeholder={
              editor === "clip"
                ? "e.g. The part where he explains how SEO got him his first 1,000 users"
                : "e.g. Lead with the $18K/month number, then the automated marketing behind it"
            }
            hint={
              editor === "clip"
                ? "Which part of the video, or what the clip should be about. The clip is picked and the post written around it; leave it blank and AI picks the strongest moment."
                : "What the post is about: a topic, a point to make, a part of the video. The draft is built around it; leave it blank and it picks."
            }
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {EDITOR_LINE[editor]}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={create}
              disabled={!ready}
              data-testid="new-post-create"
            >
              {creating ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
