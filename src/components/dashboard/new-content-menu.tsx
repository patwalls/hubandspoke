"use client";

// The nav's "New" button (flag `newsletterDrafter`): start a piece of content
// from anywhere in the app. The menu lists every kind we make; each kind's
// dialog asks for what it needs — above all the PILLAR content it is made
// from — and then opens the right editor. Newsletter is live: pick the
// brand, the newsletter format, its pillar content (a video for one-video
// formats; for roundups, the brand's videos and case studies from the last N
// days, picked by the drafter) and a send date → the draft starts and the
// newsletter editor opens on it. The other kinds (Instagram post / reel,
// YouTube Short, LinkedIn post) are listed but not wired yet.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, Mail, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { cn } from "@/lib/utils";

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

/** Every kind of content the menu offers, in order; `platform` draws its logo. */
const KINDS = [
  {
    key: "newsletter",
    label: "Newsletter",
    platform: "newsletter",
    soon: false,
  },
  {
    key: "instagram_post",
    label: "Instagram post",
    platform: "instagram",
    soon: true,
  },
  {
    key: "instagram_reel",
    label: "Instagram reel",
    platform: "instagram",
    soon: true,
  },
  {
    key: "youtube_short",
    label: "YouTube Short",
    platform: "youtube",
    soon: true,
  },
  {
    key: "linkedin_post",
    label: "LinkedIn post",
    platform: "linkedin",
    soon: true,
  },
] as const;

export function NewContentMenu({
  brands,
  currentBrand,
}: {
  brands: BrandOption[];
  currentBrand: string | null;
}) {
  const flags = useFeatureFlags();
  const [open, setOpen] = useState<"newsletter" | null>(null);
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
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Create new…
            </DropdownMenuLabel>
            {KINDS.map((k) => (
              <DropdownMenuItem
                key={k.key}
                disabled={k.soon}
                onClick={() => !k.soon && setOpen("newsletter")}
                className={cn("gap-2", !k.soon && "cursor-pointer")}
                title={k.soon ? "Coming soon" : undefined}
              >
                <PlatformIcon
                  platform={k.platform}
                  size={15}
                  inheritColor
                  className={
                    k.soon
                      ? "text-muted-foreground/60"
                      : "text-muted-foreground"
                  }
                />
                <span className="flex-1">{k.label}</span>
                {k.soon && (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Soon
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "newsletter" && (
        <NewNewsletterDialog
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label className="flex flex-col gap-1.5 text-sm">
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
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Notes for the drafter (optional)
              </span>
              <Textarea
                className="min-h-9 text-sm"
                rows={1}
                placeholder="An offer to pitch, an angle, anything it should know"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>
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
