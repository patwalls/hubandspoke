"use client";

import React, { useRef, useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronDownIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileTextIcon, FilmIcon, GitMerge, LinkIcon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon, RepeatIcon, Share2Icon, SkullIcon, SparklesIcon, Trash2Icon, TrendingUpIcon, UploadIcon } from "lucide-react";
import type { ProductionItem } from "@/types";
import { AttachDmKeywordDialog } from "@/components/dashboard/attach-dm-keyword-dialog";
import {
  ViewsSparkline,
  type ViewHistoryPoint,
} from "@/components/dashboard/views-sparkline";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PillarPicker, type PillarOption } from "./pillar-picker";
import { ContentActivity } from "./content-activity";
import { CrossPostTriagePanel } from "./cross-post-triage-dialog";
import { RepostTriagePanel } from "./repost-triage-dialog";
import type { BrandAccount } from "@/lib/services/cross-post-candidates";
import { TranscriptButton } from "./transcript-dialog";
import { EnrichmentButton, type EnrichmentMedia } from "./enrichment-dialog";
import { coverImageUrl } from "@/lib/cover-image";
import { CoverImg } from "./cover-img";
import { cn } from "@/lib/utils";
import { statusClassFromToken, statusClassWithPalette } from "@/lib/badge-colors";
import {
  AccountPostTypePicker,
  type PickerAccount,
} from "@/components/ui/account-post-type-picker";
import { AccountBadge } from "@/components/ui/account-badge";
import { SourceBadge } from "@/components/ui/source-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FormatChannelWithAccount } from "@/lib/format-channels";
import type { PostType } from "@/lib/platform-field-schemas";
import { PLATFORM_META, toPlatform } from "@/lib/platforms";
import { ClipIdeasPanel } from "./clip-ideas-panel";
import { ContentPreview } from "./preview/content-preview";
import { MergeModal } from "./merge-modal";
import { PublishedEmbed } from "./preview/published-embed";
import type { ContentDraftContent, FormatFieldSchema } from "@/lib/db/schema";

// Server returns contentDrafts rows with `createdAt`/`updatedAt` as ISO
// strings (JSON), not Date objects — keep a local shape for that.
export interface DraftRow {
  id: string;
  productionItemId: string;
  version: number;
  isCurrent: boolean;
  content: ContentDraftContent;
  fieldSchemaSnapshot: FormatFieldSchema;
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type FieldSaveState = "idle" | "saving" | "saved" | "error";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { PublishScheduleDialog } from "./publish-schedule-dialog";
import { UserChip } from "./user-chip";
import { renderInstructions } from "@/lib/utils/markdown";
import { recordVisit } from "@/lib/hooks/use-recent-items";
import { validatePublishedLinkPlatform } from "@/lib/published-link-validation";

interface BrandFormat {
  id: string;
  name: string;
  parentFormatId: string | null;
  instructions: string | null;
  // Extra fields surfaced by the Repurpose tab so it can mirror the
  // /{brand}/formats listing layout. Only populated on `repurposeTargets` —
  // the bare `formatNames` list shape stays smaller; readers tolerate
  // undefined.
  viewThreshold?: number | null;
  editor?: string | null;
  accountChannels?: FormatChannelWithAccount[];
  totalViews?: number;
}

type DerivativeRow = ProductionItem & { depth: number };

interface PillarRef {
  id: string;
  title: string | null;
  format: string | null;
}

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface RepostRow {
  id: string;
  title: string | null;
  thumbnail: string | null;
  posterUrl: string | null;
  mediaUrl: string | null;
  mediaContentType: string | null;
  status: string | null;
  platform: string[] | null;
  postType: string | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
  } | null;
  publishedDate: string | null;
  publishedLink: string | null;
  views: number | null;
  viewsEstimated: boolean | null;
  likes: number | null;
  comments: number | null;
  createdAt: string;
}

interface RepostedFromRef {
  id: string;
  title: string | null;
  publishedDate: string | null;
  publishedLink: string | null;
  views: number | null;
  evergreenReasoning: string | null;
}

interface TopPerformer {
  id: string;
  title: string | null;
  views: number | null;
  publishedDate: string | null;
  thumbnail: string | null;
  posterUrl: string | null;
  mediaUrl: string | null;
  mediaContentType: string | null;
}

interface ItemTranscript {
  fullText: string;
  source: string;
  model: string | null;
  wordCount: number | null;
  durationSec: number | null;
  audioS3Bucket: string | null;
  audioS3Key: string | null;
}

interface PredictionCohort {
  cohort: "A" | "B" | "C" | "D" | "E";
  label: string;
  n: number;
  median: number;
  weight: number;
}

interface ViewPrediction {
  prediction: number | null;
  p25: number | null;
  p75: number | null;
  confidence: "high" | "med" | "low";
  cohortBreakdown: PredictionCohort[];
  reason?: "insufficient_data";
}

interface DetailResponse {
  item: ProductionItem;
  transcript: ItemTranscript | null;
  derivatives: DerivativeRow[];
  descendantViewsTotal: number;
  formatNames: string[];
  formats: BrandFormat[];
  repurposeTargets: BrandFormat[];
  pillar: PillarRef | null;
  editor: AssignableUser | null;
  topPerformers: TopPerformer[];
  reposts: RepostRow[];
  crossPosts: RepostRow[];
  repostedFrom: RepostedFromRef | null;
  prediction: ViewPrediction | null;
  currentDraft: DraftRow | null;
  hasFieldSchema: boolean;
  media?: EnrichmentMedia[];
  /** Every `view_snapshots` row for this item, oldest → newest. Powers the
   *  little sparkline on the Views stats card. Empty for items that
   *  pre-date velocity tracking. */
  viewHistory?: ViewHistoryPoint[];
}

type StatusOption = {
  id: string;
  name: string;
  color: string;
  position: number;
};

interface ContentDetailProps {
  brand: string;
  contentId: string;
  /** Every account (across brands) for the picker dropdown. Loaded once
   *  on the server page; the picker grouping uses `brandLabel`. */
  accounts: PickerAccount[];
  /** Base host for the short-link service (e.g. https://go.starterstory.com).
   *  Threaded from the server so the UI can render the full redirect URL
   *  without needing a NEXT_PUBLIC_ env var. */
  shortLinksBaseUrl: string;
  /** Per-brand status palette. Loaded server-side and passed in so the
   *  status dropdown + chip render the brand's configured colors / order. */
  statuses: StatusOption[];
  /** Resolved server-side from the session so client components can hide
   *  admin-only affordances (e.g. the clip-ideas Generate button) instead
   *  of letting non-admins click them and get a 403 Forbidden. */
  isAdmin: boolean;
}

const FALLBACK_STATUS_OPTIONS: StatusOption[] = [
  { id: "fb-idea", name: "Idea", color: "zinc", position: 0 },
  { id: "fb-assigned", name: "Assigned", color: "pink", position: 1 },
  { id: "fb-review", name: "Review", color: "yellow", position: 2 },
  { id: "fb-final", name: "Final Review", color: "orange", position: 3 },
  { id: "fb-rtp", name: "Ready To Publish", color: "pink", position: 4 },
  { id: "fb-pub", name: "Published", color: "pink", position: 5 },
  { id: "fb-killed", name: "Killed", color: "zinc", position: 6 },
];

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-center gap-3 min-h-9 px-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function PropertyRowGroup({
  children,
  single = false,
}: {
  children: React.ReactNode;
  single?: boolean;
}) {
  if (single) {
    return (
      <div className="divide-y divide-border/60 border-b border-border/60 last:border-b-0">
        {children}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-border/60 border-b border-border/60 last:border-b-0">
      {children}
    </div>
  );
}

function PropertyRowSolo({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-border/60 last:border-b-0">{children}</div>;
}

const PROPERTY_INPUT_CLASS =
  "border-0 bg-transparent shadow-none h-8 px-2 rounded-sm focus-visible:ring-1 focus-visible:ring-ring hover:bg-muted/50 transition-colors";
const PROPERTY_TRIGGER_CLASS =
  "border-0 bg-transparent shadow-none h-8 px-2 rounded-sm focus:ring-1 focus:ring-ring hover:bg-muted/50 transition-colors";

// Title-area chip system. Two visual patterns the rest of the page leans
// on; every chip in the identity / state rows belongs to one or the
// other. Anything with a chevron is editable (Pattern A); anything
// without is read-only data (Pattern B). New chips added to either row
// should reuse these strings so the look stays consistent.
//
// Pattern A — "Editable property chip". Trailing chevron is mandatory
// and supplied by the caller. The Status variant adds a palette tint via
// `statusClassWithPalette` *on top of* this base.
const CHIP_A_BASE =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-muted/50 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";
// Pattern B — "Read-only info tag". Optional `CHIP_B_CLICKABLE` is added
// when the chip opens an info popover / dialog.
const CHIP_B_BASE =
  "inline-flex h-6 items-center gap-1.5 px-1.5 text-xs text-muted-foreground";
const CHIP_B_CLICKABLE =
  "hover:bg-muted/40 rounded-md cursor-pointer transition-colors";

const DETAIL_TAB_VALUES = [
  "details",
  "preview",
  "derivatives",
  "cross-post",
  "repost",
  "clip-ideas",
  "repurpose",
] as const;
type DetailTab = (typeof DETAIL_TAB_VALUES)[number];

export function ContentDetail({ brand, contentId, accounts, shortLinksBaseUrl, statuses, isAdmin }: ContentDetailProps) {
  // Sorted dropdown order; palette map for quick chip-color lookup.
  // Published / Scheduled are filtered OUT of the dropdown — those two
  // transitions are reachable only through the PublishScheduleDialog
  // (header-strip button). The palette map still includes them so the
  // current-state chip renders the right color when an item is already
  // in one of those states.
  const allStatusOptions = (statuses && statuses.length > 0 ? statuses : FALLBACK_STATUS_OPTIONS)
    .slice()
    .sort((a, b) => a.position - b.position);
  const statusOptions = allStatusOptions.filter(
    (s) => s.name !== "Published" && s.name !== "Scheduled",
  );
  const statusPalette = new Map(allStatusOptions.map((s) => [s.name, s.color] as const));

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTabParam: DetailTab = DETAIL_TAB_VALUES.includes(
    tabParam as DetailTab,
  )
    ? (tabParam as DetailTab)
    : "details";
  const setActiveTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "details") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);

  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [liveContent, setLiveContent] = useState<ContentDraftContent | null>(
    null,
  );
  const [fieldSaves, setFieldSaves] = useState<Record<string, FieldSaveState>>(
    {},
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Live Descript status — separate from the production_item columns so
  // we can surface in-flight queue jobs (clip-idea-precise-cut /
  // descript-clip-resolve / publish-and-archive) that haven't yet stamped
  // their results back. Polled lightly when work is in flight; idle
  // otherwise. Drives the simulator's "processing" placeholder so editors
  // see "Cutting clip in Descript…" the second the job lands in the
  // queue, instead of staring at the empty drag-to-add zone.
  const [descriptStatusLive, setDescriptStatusLive] =
    useState<DescriptStatusResponse | null>(null);
  // Draft Algorithm running state — locks the caption editor while a
  // `draft-algorithm-run` job is queued/in-flight for this item. Without
  // this, an editor who opens the page right after a clip-promote
  // (which auto-fires the algorithm) can start typing — only to have
  // their text obliterated when the algorithm writes its draft a few
  // seconds later. Polled at the same cadence as descript-status.
  const [draftAlgorithmRunning, setDraftAlgorithmRunning] =
    useState<boolean>(false);
  useEffect(() => {
    if (!data?.item?.id) return;
    const itemId = data.item.id;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fetchStatus = async () => {
      try {
        const res = await fetch(
          `/api/production-items/${itemId}/descript-status`,
        );
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DescriptStatusResponse;
        if (!cancelled) setDescriptStatusLive(json);
      } catch {
        // Best-effort; transient fetch errors just leave stale data.
      }
    };
    void fetchStatus();
    // Poll while work is in flight — same trigger as DescriptStatusPill.
    timer = setInterval(() => {
      if (cancelled) return;
      const s = descriptStatusLive;
      const inFlight =
        !s ||
        s.status === "processing" ||
        s.status === "stalled" ||
        s.publish.state === "rendering";
      if (inFlight) void fetchStatus();
    }, 10_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // descriptStatusLive intentionally omitted from deps — the interval
    // reads the latest via closure-over-ref-style isn't possible here, so
    // we accept that the "inFlight" check uses the value at effect-setup
    // time. The 10s cadence is cheap enough that staying-on after work
    // finishes for one extra tick is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.item?.id]);

  // Draft-algorithm poller — separate from descript-status so the two
  // signals stay decoupled. Polls every 5s while running so the lock
  // releases quickly once the draft commits, then idles. Stops polling
  // once it sees `idle` (no further wakeups needed until the user
  // triggers a regenerate, at which point the user-side action can
  // refetch).
  useEffect(() => {
    if (!data?.item?.id) return;
    const itemId = data.item.id;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fetchStatus = async () => {
      try {
        const res = await fetch(
          `/api/production-items/${itemId}/draft-algorithm-status`,
        );
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { state: "idle" | "running" };
        if (!cancelled) setDraftAlgorithmRunning(json.state === "running");
      } catch {
        // Non-fatal; leave the lock state stale.
      }
    };
    void fetchStatus();
    timer = setInterval(() => void fetchStatus(), 5_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [data?.item?.id]);

  useEffect(() => {
    const item = data?.item;
    if (!item) return;
    recordVisit({
      kind: "content",
      id: contentId,
      title: item.title ?? "(untitled)",
      subtitle: item.format ?? undefined,
      brand,
      href: `/${brand}/content/${contentId}`,
    });
  }, [brand, contentId, data?.item]);

  // Auto-clear the "Saved" pill so it doesn't stay pinned after a single edit.
  // Errors persist until the next save attempt so the user can read them.
  useEffect(() => {
    if (saveState.kind !== "saved") return;
    const t = setTimeout(() => setSaveState({ kind: "idle" }), 1500);
    return () => clearTimeout(t);
  }, [saveState]);

  // Poll for descriptCompositionId while a clip-sourced item is still
  // waiting on the Descript agent job (the worker at
  // src/jobs/tasks/descript-clip-resolve.ts fills it in ~30–60s after
  // creation). Once populated, we can deep-link the Descript button to
  // the new composition instead of the project root. Bail out after 5
  // minutes so we don't poll forever on failed jobs.
  useEffect(() => {
    const item = data?.item;
    if (!item) return;
    const pending =
      !!item.sourceClipIdeaId &&
      !!item.descriptProjectId &&
      !item.descriptCompositionId;
    if (!pending) return;

    let cancelled = false;
    const deadline = Date.now() + 5 * 60 * 1000;
    const tick = async () => {
      if (cancelled || Date.now() > deadline) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await fetch(`/api/production-items/${item.id}`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DetailResponse;
        if (json.item.descriptCompositionId) {
          setData((prev) => (prev ? { ...prev, item: json.item } : prev));
          clearInterval(interval);
        }
      } catch {
        // Silent: next tick will retry.
      }
    };
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    data?.item?.id,
    data?.item?.sourceType,
    data?.item?.descriptProjectId,
    data?.item?.descriptCompositionId,
  ]);

  // Poll for the rendered MP4 to land in `production_item_media` while a
  // Descript publish-and-archive job is in flight. The publish task in
  // src/jobs/tasks/descript-publish-and-archive.ts can take 2–10 minutes;
  // without this poll the simulator stays on the rendering placeholder
  // until the editor manually refreshes. Bails out as soon as a video row
  // appears (then the simulator switches to the playable `<video>`), or
  // after the publish job errors out, or after 15 minutes.
  useEffect(() => {
    const item = data?.item;
    if (!item) return;
    const renderInFlight =
      !!item.descriptCompositionId &&
      !item.descriptPublishedAt &&
      !item.descriptPublishError &&
      !!item.descriptPublishJobId;
    const renderJustLanded =
      !!item.descriptPublishedAt &&
      !(data.media ?? []).some((m) => m.kind === "video" && !!m.url);
    if (!renderInFlight && !renderJustLanded) return;

    let cancelled = false;
    const deadline = Date.now() + 15 * 60 * 1000;
    const tick = async () => {
      if (cancelled || Date.now() > deadline) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await fetch(`/api/production-items/${item.id}`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DetailResponse;
        const hasVideo = (json.media ?? []).some(
          (m) => m.kind === "video" && !!m.url,
        );
        if (
          hasVideo ||
          json.item.descriptPublishError ||
          (!json.item.descriptPublishJobId && !json.item.descriptPublishedAt)
        ) {
          setData(json);
          clearInterval(interval);
        } else {
          setData(json);
        }
      } catch {
        // Silent: next tick will retry.
      }
    };
    const interval = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    data?.item?.id,
    data?.item?.descriptCompositionId,
    data?.item?.descriptPublishJobId,
    data?.item?.descriptPublishedAt,
    data?.item?.descriptPublishError,
    data?.media,
  ]);

  // Auto-trigger Descript publish-and-archive when an editor lands on a
  // clip whose composition exists but no MP4 has been rendered yet.
  // Two cases this rescues:
  //   1. Legacy items created before the descript-clip-resolve auto-chain
  //      (commit d57bf09) — they're stuck in `awaiting` forever.
  //   2. Auto-chain enqueued the publish job but it errored silently or
  //      got dropped before stamping `descriptPublishJobId`.
  // The publish task is idempotent (race-guards on jobId, no-ops when
  // already published), so an extra fire is cheap. Tracked in a ref so we
  // only attempt once per item per page-mount.
  const autoPublishFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const item = data?.item;
    if (!item) return;
    const awaitingPublish =
      !!item.sourceClipIdeaId &&
      !!item.descriptCompositionId &&
      !item.descriptPublishJobId &&
      !item.descriptPublishedAt &&
      !item.descriptPublishError;
    if (!awaitingPublish) return;
    if (autoPublishFiredRef.current === item.id) return;
    autoPublishFiredRef.current = item.id;
    void fetch(
      `/api/production-items/${item.id}/sync-descript-publish`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    ).catch(() => {
      // Silent — the user can still hit "Render now" on the simulator
      // placeholder if this fails.
    });
  }, [
    data?.item?.id,
    data?.item?.sourceType,
    data?.item?.descriptCompositionId,
    data?.item?.descriptPublishJobId,
    data?.item?.descriptPublishedAt,
    data?.item?.descriptPublishError,
  ]);

  // Auto-create an empty draft row for any inline-drafting item that
  // doesn't have one yet, so the simulator flips from "Read-only — no
  // draft yet" to editable on first land. Only IG goes through the
  // generate-caption auto-fire below; X / LinkedIn / TikTok / Threads
  // need at minimum an empty draft so the editor can start typing and
  // upload media. Idempotent server-side; ref-gated client-side so we
  // don't fire twice per id.
  const ensureDraftFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const it = data?.item;
    if (!it) return;
    if (data?.currentDraft) return;
    const isInlineDrafting =
      typeof it.postType === "string" &&
      INLINE_DRAFTING_POST_TYPES.has(it.postType);
    const isPrePub = it.status !== "Published";
    if (!isInlineDrafting || !isPrePub) return;
    if (ensureDraftFiredRef.current === it.id) return;
    ensureDraftFiredRef.current = it.id;
    void fetch(`/api/production-items/${it.id}/drafts/ensure`, {
      method: "POST",
    })
      .then(async (res) => {
        if (!res.ok) return;
        // Refetch so `currentDraft` lands and the simulator becomes
        // editable. The IG auto-generate hook below picks up from here
        // for IG items and fills in an AI caption.
        void load();
      })
      .catch(() => {
        // Silent — user can refresh manually if this fails.
      });
    // Intentionally omitting `load` from deps; `ensureDraftFiredRef`
    // already prevents repeat fires per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.item?.id, data?.item?.postType, data?.item?.status, data?.currentDraft]);

  // Auto-fire the Draft Algorithm when an editor lands on an IG drafting
  // surface that has no draft yet. The cross-post / repurpose routes
  // already enqueue this post-create, but clip-promotion writes a
  // `production_items` row WITHOUT a `content_drafts` row — so without
  // this hook those clip items show no generated caption until the user
  // clicks Generate. Scoped to IG to preserve today's behavior; new
  // platforms (X / LinkedIn / TikTok / Threads / etc.) get coverage via
  // the route-side enqueues. Fires once per item per page-mount;
  // idempotent because the service skips when a non-`copy:source` draft
  // already exists.
  const autoGenCaptionFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const item = data?.item;
    if (!item) return;
    const isIg =
      typeof item.postType === "string" && item.postType.startsWith("instagram_");
    const noDraft = !data?.currentDraft;
    const hasTranscript = !!data?.transcript;
    if (!isIg || !noDraft || !hasTranscript) return;
    if (autoGenCaptionFiredRef.current === item.id) return;
    autoGenCaptionFiredRef.current = item.id;
    void fetch(`/api/production-items/${item.id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        // On success the service inserted a new `contentDrafts` row.
        // Refetch so the simulator flips to editable + shows the AI-
        // generated caption.
        void load();
      })
      .catch(() => {
        // Silent — Generate button on the panel is the manual fallback.
      });
    // `load` is stable enough across renders that omitting it from deps
    // here doesn't cause stale-closure issues; including it would re-fire
    // the auto-gen on every refetch, defeating the purpose of the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data?.item?.id,
    data?.item?.postType,
    data?.currentDraft,
    data?.transcript,
  ]);

  // Auto-clear per-field "Saved" pills 1.5s after each successful save.
  useEffect(() => {
    const savedKeys = Object.entries(fieldSaves)
      .filter(([, v]) => v === "saved")
      .map(([k]) => k);
    if (savedKeys.length === 0) return;
    const t = setTimeout(() => {
      setFieldSaves((prev) => {
        const next = { ...prev };
        for (const key of savedKeys) next[key] = "idle";
        return next;
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [fieldSaves]);

  // Per-format Create state, keyed by format id.
  type CreateState = "idle" | "creating";
  const [createStatus, setCreateStatus] = useState<Record<string, CreateState>>(
    {}
  );
  // Synchronous in-flight guard. The button's `disabled` attribute is driven
  // by `createStatus`, but state updates don't paint until the next render —
  // a fast double-click can fire `onClick` twice before React disables the
  // button. The ref blocks the second call instantly.
  const createInFlight = useRef<Set<string>>(new Set());
  const [creatingAll, setCreatingAll] = useState(false);

  // Descript upload modal state
  const [descriptModalOpen, setDescriptModalOpen] = useState(false);
  const [descriptReplacing, setDescriptReplacing] = useState(false);
  const [descriptMode, setDescriptMode] = useState<"upload" | "url">("upload");
  const [descriptUrl, setDescriptUrl] = useState("");
  const [descriptFile, setDescriptFile] = useState<File | null>(null);
  const [descriptStage, setDescriptStage] = useState<
    "idle" | "creating" | "uploading" | "done"
  >("idle");
  const [descriptProgress, setDescriptProgress] = useState(0);
  const [descriptError, setDescriptError] = useState<string | null>(null);
  const [descriptResult, setDescriptResult] = useState<
    { projectUrl: string } | null
  >(null);

  // Standalone media-upload modal — uploads a video/audio file straight to
  // S3 (no Descript step). Confirm route auto-enqueues Whisper, so by the
  // time the editor checks back the transcript is ready and clip ideas
  // can be generated even on a not-yet-published item.
  const [mediaUploadOpen, setMediaUploadOpen] = useState(false);
  const [mediaUploadFile, setMediaUploadFile] = useState<File | null>(null);

  // Merge modal for manually merging duplicate items
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mediaUploadStage, setMediaUploadStage] = useState<
    "idle" | "uploading" | "confirming" | "done"
  >("idle");
  const [mediaUploadProgress, setMediaUploadProgress] = useState(0);
  const [mediaUploadError, setMediaUploadError] = useState<string | null>(null);

  // Manual metrics refresh state for the Sync button on the metrics grid.
  // `error` holds a non-fatal note (e.g. "not found in recent feed") so the
  // user sees why metrics didn't move even though the call succeeded.
  const [syncState, setSyncState] = useState<
    | { kind: "idle" }
    | { kind: "syncing" }
    | { kind: "synced" }
    | { kind: "note"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Spawn a derivative production_item in the target format, assigned to
  // the calling user. Always creates a new draft — the route no longer
  // dedups on (pillar, format), since a manual click is treated as the
  // editor deliberately wanting another angle.
  async function createDerivative(
    targetFormatId: string,
    targetFormatName: string,
    options: { redirectOnSuccess: boolean } = { redirectOnSuccess: true }
  ): Promise<{ id: string } | null> {
    if (createInFlight.current.has(targetFormatId)) return null;
    createInFlight.current.add(targetFormatId);
    setCreateStatus((prev) => ({ ...prev, [targetFormatId]: "creating" }));
    try {
      const res = await fetch(
        `/api/production-items/${contentId}/repurpose`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetFormatId }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.id) {
        if (options.redirectOnSuccess) {
          toast.success(`Created ${targetFormatName}`);
          router.push(`/${brand}/content/${json.id}`);
        }
        return { id: json.id };
      }
      toast.error(json?.error || `Failed to create ${targetFormatName}`);
      return null;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to create ${targetFormatName}`
      );
      return null;
    } finally {
      createInFlight.current.delete(targetFormatId);
      setCreateStatus((prev) => ({ ...prev, [targetFormatId]: "idle" }));
    }
  }

  async function createAll(targets: { id: string; name: string }[]) {
    if (creatingAll || targets.length === 0) return;
    setCreatingAll(true);
    let created = 0;
    let failed = 0;
    try {
      for (const t of targets) {
        const result = await createDerivative(t.id, t.name, {
          redirectOnSuccess: false,
        });
        if (result) created++;
        else failed++;
      }
      const parts: string[] = [];
      if (created > 0)
        parts.push(`${created} new draft${created === 1 ? "" : "s"}`);
      if (failed > 0) parts.push(`${failed} failed`);
      const summary = parts.join(" · ") || "Nothing happened";
      if (failed > 0 && created === 0) toast.error(summary);
      else if (failed > 0) toast.warning(summary);
      else toast.success(summary);
      load();
    } finally {
      setCreatingAll(false);
    }
  }

  function openDescriptModal() {
    setDescriptReplacing(!!data?.item.descriptProjectId);
    setDescriptMode("upload");
    setDescriptFile(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptModalOpen(true);
  }

  function closeDescriptModal() {
    setDescriptModalOpen(false);
    setDescriptFile(null);
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
    setS3KeyForRetry(null);
  }

  async function submitDescriptUrl() {
    if (!data || !descriptUrl.trim()) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    try {
      const res = await fetch("/api/descript/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "url",
          url: descriptUrl.trim(),
          projectName: data.item.title || "Imported video",
          itemId: contentId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDescriptError(json.error || `HTTP ${res.status}`);
        setDescriptStage("idle");
      } else {
        setDescriptResult({ projectUrl: json.projectUrl });
        setDescriptStage("done");
        load();
      }
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Request failed");
      setDescriptStage("idle");
    }
  }

  const [s3KeyForRetry, setS3KeyForRetry] = useState<string | null>(null);

  async function callDescriptForS3Key(key: string, projectName: string) {
    const res = await fetch("/api/descript/create-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "s3", s3Key: key, projectName, itemId: contentId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.projectUrl as string;
  }

  async function retryDescriptImport() {
    if (!data || !s3KeyForRetry) return;
    setDescriptError(null);
    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        s3KeyForRetry,
        data.item.title || "Imported video"
      );
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Descript import failed");
      setDescriptStage("idle");
    }
  }

  async function submitDescriptUpload() {
    if (!data || !descriptFile) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptProgress(0);
    setS3KeyForRetry(null);

    let uploadUrl: string, key: string, bucket: string;
    try {
      const res = await fetch("/api/uploads/s3-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
          fileName: descriptFile.name,
          contentType: descriptFile.type || "video/mp4",
          fileSize: descriptFile.size,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDescriptError(json.error || `HTTP ${res.status}`);
        setDescriptStage("idle");
        return;
      }
      uploadUrl = json.uploadUrl;
      key = json.key;
      bucket = json.bucket;
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Request failed");
      setDescriptStage("idle");
      return;
    }

    setDescriptStage("uploading");
    const contentType = descriptFile.type || "video/mp4";
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setDescriptProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        });
        xhr.addEventListener("error", () => reject(new Error("Upload failed (network)")));
        xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.send(descriptFile);
      });
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Upload failed");
      setDescriptStage("idle");
      return;
    }

    try {
      const res = await fetch("/api/uploads/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
          key,
          bucket,
          contentType,
          fileSize: descriptFile.size,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setDescriptError(json.error || `Confirm failed: HTTP ${res.status}`);
        setDescriptStage("idle");
        return;
      }
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Confirm failed");
      setDescriptStage("idle");
      return;
    }

    setS3KeyForRetry(key);

    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        key,
        data.item.title || "Imported video"
      );
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Descript import failed");
      setDescriptStage("idle");
    }
  }

  function closeMediaUploadModal() {
    setMediaUploadOpen(false);
    setMediaUploadFile(null);
    setMediaUploadStage("idle");
    setMediaUploadProgress(0);
    setMediaUploadError(null);
  }

  // Mirrors the first three steps of `submitDescriptUpload` (presign → S3
  // PUT → confirm) without the Descript-import step. The /api/uploads/confirm
  // route auto-enqueues Whisper, so the transcript lands on its own — clip
  // ideas can then be generated even on items that aren't published yet.
  async function submitMediaUpload() {
    if (!data || !mediaUploadFile) return;
    setMediaUploadStage("uploading");
    setMediaUploadError(null);
    setMediaUploadProgress(0);

    let uploadUrl: string, key: string, bucket: string;
    try {
      const res = await fetch("/api/uploads/s3-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
          fileName: mediaUploadFile.name,
          contentType: mediaUploadFile.type || "video/mp4",
          fileSize: mediaUploadFile.size,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMediaUploadError(json.error || `HTTP ${res.status}`);
        setMediaUploadStage("idle");
        return;
      }
      uploadUrl = json.uploadUrl;
      key = json.key;
      bucket = json.bucket;
    } catch (err) {
      setMediaUploadError(err instanceof Error ? err.message : "Request failed");
      setMediaUploadStage("idle");
      return;
    }

    const contentType = mediaUploadFile.type || "video/mp4";
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setMediaUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        });
        xhr.addEventListener("error", () =>
          reject(new Error("Upload failed (network)")),
        );
        xhr.addEventListener("abort", () =>
          reject(new Error("Upload aborted")),
        );
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.send(mediaUploadFile);
      });
    } catch (err) {
      setMediaUploadError(err instanceof Error ? err.message : "Upload failed");
      setMediaUploadStage("idle");
      return;
    }

    setMediaUploadStage("confirming");
    try {
      const res = await fetch("/api/uploads/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
          key,
          bucket,
          contentType,
          fileSize: mediaUploadFile.size,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setMediaUploadError(json.error || `Confirm failed: HTTP ${res.status}`);
        setMediaUploadStage("idle");
        return;
      }
    } catch (err) {
      setMediaUploadError(err instanceof Error ? err.message : "Confirm failed");
      setMediaUploadStage("idle");
      return;
    }

    setMediaUploadStage("done");
    await load();
  }

  // Form state
  const [title, setTitle] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [postType, setPostType] = useState<PostType | null>(null);
  const [format, setFormat] = useState("");
  const [formatPickerOpen, setFormatPickerOpen] = useState(false);
  const [formatSearch, setFormatSearch] = useState("");
  // Separate state for the Repurpose tab's "any format" picker (distinct
  // from the Format chip picker above so opening one doesn't close the
  // other). On select, it fires `createDerivative` and redirects — no
  // local format state to track.
  const [repurposeAnyOpen, setRepurposeAnyOpen] = useState(false);
  const [repurposeAnySearch, setRepurposeAnySearch] = useState("");
  const [status, setStatus] = useState("");
  const [pillar, setPillar] = useState<PillarOption | null>(null);
  const [repostedFromOption, setRepostedFromOption] =
    useState<PillarOption | null>(null);
  const [editorUserId, setEditorUserId] = useState<string>("");
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [publishedLink, setPublishedLink] = useState("");
  const [publishedDate, setPublishedDate] = useState("");
  const [utmCampaign, setUtmCampaign] = useState("");
  const [generatingUtm, setGeneratingUtm] = useState(false);
  const [sourceType, setSourceType] = useState<string>("original");
  const [dmKeywordDialogOpen, setDmKeywordDialogOpen] = useState(false);
  // Destination URL for the attached DM keyword slug. Fetched from the
  // short-links proxy when shortLinkSlug changes, bumped by dmRefresh after a
  // dialog save (so destination edits on the same slug re-fetch). Admin-only
  // path — the proxy 403s otherwise.
  const [dmDestinationUrl, setDmDestinationUrl] = useState<string | null>(null);
  const [dmRefresh, setDmRefresh] = useState(0);
  const [pendingKill, setPendingKill] = useState<{ previousStatus: string } | null>(
    null,
  );
  // Publish-or-Schedule modal. Single source of truth for transitioning
  // an item to status='Published' or 'Scheduled' (the generic PUT route
  // rejects those status values directly so editors can't half-publish).
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  // "More fields" toggle: hides Account, Pillar, Source type, Reposted from
  // by default so the metadata card surfaces only the fields a clip operator
  // routinely edits (Editor, Status, Format, CTA UTM, DM keyword).
  // `showMore` state removed 2026-05-15 — the "See more fields" toggle
  // went away when Editor / Status / Format moved up to the title chip
  // row, leaving only advanced fields in the sidebar (now always-shown).
  // Title is rendered as a heading above the card; pencil swaps in an Input
  // with autoFocus so it receives focus immediately on mount.
  const [editingTitle, setEditingTitle] = useState(false);

  // handleCrossPost / handleRepost removed 2026-05-19 — the per-target
  // submenu was replaced with CrossPostTriageDialog / RepostTriageDialog
  // (same components the hot queue uses). The dialogs own their own
  // submit handlers and assignee picker.

  const handleDuplicate = useCallback(async () => {
    if (actionPending) return;
    setActionPending(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}/duplicate`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Failed to duplicate");
        return;
      }
      toast.success("Duplicated — opening the copy");
      router.push(`/${brand}/content/${json.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate");
    } finally {
      setActionPending(false);
    }
  }, [actionPending, brand, contentId, router]);

  // Trigger the Descript publish-and-archive flow: render the current
  // composition to MP4 and pull it back into our S3. The Descript pill
  // takes over showing the "rendering" state once the worker picks it up.
  const handleDownloadFromDescript = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/production-items/${contentId}/sync-descript-publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Couldn't start render", {
          description: json?.error || `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Rendering MP4 in Descript…", {
        description:
          "Takes about 2 minutes. The simulator will update when it lands.",
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't start render",
      );
    }
  }, [contentId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setAssignableUsers(json.users || []);
      } catch {
        // Non-fatal: the form still works without suggestions.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // crossPostCandidates memo removed 2026-05-19 — the dialog builds its
  // own target list from `brandAccounts` (with the dedup / Notion-auth /
  // already-done logic in one place rather than mirrored across surfaces).

  const applyItem = useCallback(
    (
      item: ProductionItem,
      pillarRef: PillarRef | null,
      repostedFromRef: RepostedFromRef | null,
    ) => {
      setTitle(item.title || "");
      setAccountId(item.accountId ?? null);
      setPostType((item.postType as PostType | null) ?? null);
      setFormat(item.format || "");
      setStatus(item.status || "");
      setPillar(pillarRef);
      setRepostedFromOption(
        repostedFromRef
          ? {
              id: repostedFromRef.id,
              title: repostedFromRef.title,
              format: null,
              status: null,
            }
          : null,
      );
      setEditorUserId(item.editorUserId || "");
      setPublishedLink(item.publishedLink || "");
      setPublishedDate(item.publishedDate || "");
      setUtmCampaign(item.utmCampaign || "");
      setSourceType(item.sourceType || "original");
    },
    [],
  );

  // Note: previously we auto-expanded "See more fields" for repost /
  // cross-post items (so the Reposted-from picker would be visible).
  // Removed 2026-05-08 per user request — extras stay collapsed by
  // default on every item; the editor clicks "See more fields" when
  // they need to inspect or change the routing.

  const slugAttached = data?.item?.shortLinkSlug ?? null;
  useEffect(() => {
    if (!slugAttached) {
      setDmDestinationUrl(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/short-links/${encodeURIComponent(slugAttached)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { destinationUrl?: string } | null) => {
        if (cancelled || !payload) return;
        setDmDestinationUrl(payload.destinationUrl ?? null);
      })
      .catch(() => {
        if (!cancelled) setDmDestinationUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slugAttached, dmRefresh]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      const json = (await res.json()) as DetailResponse;
      setData(json);
      applyItem(json.item, json.pillar ?? null, json.repostedFrom ?? null);
    } catch (err) {
      console.error("Failed to load content detail:", err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [contentId, applyItem]);

  useEffect(() => {
    load();
  }, [load]);

  // Manual entry point for the Draft Algorithm. `force: true` because this
  // is an explicit operator click — bypass the "already-filled" idempotency
  // guard so an existing draft gets overwritten. Use cases: rapid prompt
  // iteration, and backfilling drafts on items created before the algorithm
  // was wired in.
  const handleRedraft = useCallback(async () => {
    if (actionPending) return;
    setActionPending(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // userInitiated=true → per-field change events get attributed to the
        // editor and land in the main activity feed (not under "Show system
        // changes"). Distinguishes this deliberate click from auto-fires.
        body: JSON.stringify({ force: true, userInitiated: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't redraft");
        return;
      }
      if (json?.status === "skipped") {
        toast.message("Skipped", {
          description: json.reason ?? "Nothing to draft.",
        });
        return;
      }
      toast.success("Redrafted");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to redraft");
    } finally {
      setActionPending(false);
    }
  }, [actionPending, contentId, load]);

  const handleAddToDescript = useCallback(async () => {
    if (actionPending) return;
    const s3Key = data?.item.mediaS3Key;
    if (!s3Key) return;
    setActionPending(true);
    try {
      const res = await fetch("/api/descript/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "s3",
          s3Key,
          projectName: data?.item.title || "Imported video",
          itemId: contentId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Failed to add to Descript");
        return;
      }
      toast.success("Added to Descript");
      load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add to Descript",
      );
    } finally {
      setActionPending(false);
    }
  }, [actionPending, contentId, data?.item.mediaS3Key, data?.item.title, load]);

  // Sync the shared draft state with whatever the server returned on the
  // most recent load(). Only re-seeds when the server draft id changes or
  // the draft goes from absent to present (or vice versa) — mid-edit loads
  // shouldn't stomp the user's typing.
  const loadedDraft = data?.currentDraft ?? null;
  useEffect(() => {
    setDraft(loadedDraft);
    setLiveContent(loadedDraft?.content ?? null);
    setFieldSaves({});
    setFieldErrors({});
  }, [loadedDraft?.id, loadedDraft]);

  // Auto-trigger publish-and-archive when we land on a clip whose
  // composition is ready but the MP4 hasn't been rendered yet (the
  // "awaiting" state). Covers two cases:
  //   1. Old clips from before publish-and-archive existed.
  //   2. Fresh clips where the auto-chain didn't fire (e.g. the
  //      precise-cut "no Underlord" branch which doesn't currently
  //      enqueue publish — separate fix).
  // The route's race guard returns 409 on duplicate calls, so a
  // double-fire (StrictMode dev) is silent. We key on the item id +
  // state to fire exactly once per landing. We derive the awaiting flag
  // here directly (rather than reusing the later `descriptRenderState`)
  // so this useEffect can sit alongside the other early hooks before
  // the `data` guard.
  const itemIdForAutoSync = data?.item.id;
  const isAwaitingRender =
    !!data?.item.descriptCompositionId &&
    !data?.item.descriptPublishJobId &&
    !data?.item.descriptPublishedAt &&
    !data?.item.descriptPublishError;
  useEffect(() => {
    if (!itemIdForAutoSync) return;
    if (!isAwaitingRender) return;
    void fetch(
      `/api/production-items/${itemIdForAutoSync}/sync-descript-publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    ).catch(() => {
      // Best-effort. Toasts here would be noise — the placeholder UI
      // surfaces the state via its own polling.
    });
    // We intentionally only re-fire when the item or state changes.
  }, [itemIdForAutoSync, isAwaitingRender]);

  const onLocalEdit = useCallback(
    (fieldKey: string, value: string | string[]) => {
      setLiveContent((prev) => ({ ...(prev ?? {}), [fieldKey]: value }));
    },
    [],
  );

  // Commit a single field to the server. Uses the current `liveContent`
  // snapshot — blur-save semantics. Returns quickly if the value matches the
  // last server-known value for that field (avoids a PUT on every blur).
  const onCommit = useCallback(
    async (fieldKey: string) => {
      if (!draft) return;
      const nextValue = liveContent?.[fieldKey];
      const prevValue = draft.content[fieldKey];
      if (
        (typeof nextValue === "string" && prevValue === nextValue) ||
        (nextValue == null && prevValue == null)
      ) {
        return;
      }
      setFieldSaves((prev) => ({ ...prev, [fieldKey]: "saving" }));
      setFieldErrors((prev) => {
        if (!(fieldKey in prev)) return prev;
        const next = { ...prev };
        delete next[fieldKey];
        return next;
      });
      try {
        const res = await fetch(
          `/api/production-items/${contentId}/drafts/${draft.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ patch: { [fieldKey]: nextValue } }),
          },
        );
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setDraft(json.draft as DraftRow);
        setFieldSaves((prev) => ({ ...prev, [fieldKey]: "saved" }));
        // Surface the edit in the activity feed without a page reload.
        // The PUT route's transaction writes a `content_changed` event in
        // the same tx as the draft update, so by the time we get here the
        // event row exists — a refetch picks it up immediately. Mirrors
        // the bump in `persistField` for top-level production_item edits.
        setActivityRefreshKey((k) => k + 1);
      } catch (err) {
        setFieldSaves((prev) => ({ ...prev, [fieldKey]: "error" }));
        setFieldErrors((prev) => ({
          ...prev,
          [fieldKey]: err instanceof Error ? err.message : "Save failed",
        }));
        toast.error(
          err instanceof Error ? err.message : "Draft save failed",
        );
      }
    },
    [contentId, draft, liveContent],
  );

  // Every field auto-persists through here. The PUT route accepts partial
  // bodies, so we send only what changed. Server response is merged back into
  // `data.item` so derived flags like `isPublished` stay current without a full
  // reload (which would steal focus from the input the user just blurred).
  const persistField = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setSaveState({ kind: "saving" });
      try {
        const res = await fetch("/api/production-items", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: contentId, ...patch }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        setData((prev) =>
          prev ? { ...prev, item: { ...prev.item, ...payload } } : prev
        );
        setActivityRefreshKey((k) => k + 1);
        // sourceType flips can materialize reposted_from_item_id and thus the
        // "Reposted from" source card. That card reads from data.repostedFrom
        // which only the GET endpoint computes — refetch to surface it.
        if ("sourceType" in patch || "repostedFromItemId" in patch) void load();
        if (payload.notionSyncWarning) {
          const message = `Saved. Notion: ${payload.notionSyncWarning}`;
          setSaveState({ kind: "error", message });
          toast.warning(message);
        } else {
          setSaveState({ kind: "saved" });
        }
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Save failed";
        setSaveState({ kind: "error", message });
        toast.error(message);
        return false;
      }
    },
    [contentId, load]
  );

  const createFormatFromQuery = useCallback(
    async (name: string) => {
      try {
        const res = await fetch("/api/formats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, brand }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const message = err.error || "Couldn't create format";
          setSaveState({ kind: "error", message });
          toast.error(message);
          return;
        }
        const created = (await res.json()) as BrandFormat;
        setData((prev) =>
          prev
            ? {
                ...prev,
                formatNames: [...prev.formatNames, created.name].sort((a, b) =>
                  a.localeCompare(b)
                ),
                formats: [...prev.formats, created],
              }
            : prev
        );
        setFormat(created.name);
        setFormatPickerOpen(false);
        setFormatSearch("");
        void persistField({ format: created.name });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Couldn't create format";
        setSaveState({ kind: "error", message });
        toast.error(message);
      }
    },
    [brand, persistField]
  );

  const handleSync = useCallback(async () => {
    setSyncState({ kind: "syncing" });
    try {
      const res = await fetch(`/api/production-items/${contentId}/sync`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      // Merge the fresh metrics onto the local item so the stat cards update
      // without a full detail reload (which would steal input focus).
      setData((prev) => {
        if (!prev) return prev;
        const patch: Partial<ProductionItem> = {};
        if (json.views != null) patch.views = json.views;
        if (json.likes != null) patch.likes = json.likes;
        if (json.comments != null) patch.comments = json.comments;
        patch.lastPerformanceSyncAt = json.syncedAt ?? new Date().toISOString();
        return { ...prev, item: { ...prev.item, ...patch } };
      });
      if (json.updated) {
        setSyncState({ kind: "synced" });
        setTimeout(() => setSyncState({ kind: "idle" }), 2500);
      } else {
        setSyncState({
          kind: "note",
          message: json.note || "No fresh data returned",
        });
        setTimeout(() => setSyncState({ kind: "idle" }), 5000);
      }
    } catch (err) {
      setSyncState({
        kind: "error",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }, [contentId]);

  async function confirmKill(reason: string | null) {
    if (!pendingKill) return;
    const prev = pendingKill.previousStatus;
    setStatus("Killed");
    setPendingKill(null);
    const ok = await persistField({ status: "Killed", killReason: reason });
    if (!ok) setStatus(prev);
  }

  async function handleDelete() {
    if (!confirm("Delete this post? This cannot be undone.")) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        setDeleteError(err.error || "Failed to delete");
        setDeleting(false);
        return;
      }
      router.push(`/${brand}/content`);
    } catch (err) {
      setDeleteError(String(err));
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link
          href={`/${brand}/content`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to content
        </Link>
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          Post not found.
        </div>
      </div>
    );
  }

  const { item, derivatives, formatNames, repurposeTargets } = data;
  const brandFormats = formatNames;
  const isYouTube = !!item.youtubeId;
  const isPublished = !!item.publishedLink;
  const isPrePublish = item.status !== "Published";
  // Pre-publish "drafting surface" layout: simulator card on the left,
  // form metadata on the right, no Instructions panel, no separate
  // Preview tab. Wired post types are listed here; everything else
  // keeps today's form-left/Instructions-right layout.
  const INLINE_DRAFTING_POST_TYPES: ReadonlySet<string> = new Set([
    "x",
    "instagram_post",
    "instagram_reel",
    "instagram_story",
    "linkedin",
    "tiktok",
    "youtube_community",
    "youtube_shorts",
    // Threads (2026-05-15) — ThreadsSimulator was wired in
    // content-preview.tsx; the post type was just missed in this set,
    // so Threads kept falling back to the form-left/Instructions-right
    // layout. Pat shouldn't see editorial Instructions on a draftable
    // post.
    "threads",
    // Newsletter (2026-05-15) — drafting surface for in-app newsletters.
    // Subject + preview text + body editable inside the inbox mock; the
    // draft auto-ensure machinery the other inline post types use creates
    // an empty contentDrafts row on page mount so commits land cleanly.
    // For Klaviyo-synced newsletters the simulator falls back to
    // `item.title` / `item.newsletterPreviewText` / `item.contentBody`
    // until an editor types something.
    "newsletter",
  ]);
  const isPrePublishInline =
    isPrePublish && INLINE_DRAFTING_POST_TYPES.has(item.postType ?? "");
  // Two-column Details layout fires for inline-drafting items (left =
  // editable simulator) AND for published items (left = real embed of the
  // live post). Other states keep today's form-only layout.
  const showLeftPane = isPrePublishInline || isPublished;
  // Descript-render state. Drives the IG Reel embed-style placeholder
  // until the rendered MP4 actually lands in S3. Four states derived from
  // the existing `descript_*` columns:
  //   - "rendering": publish-and-archive worker is mid-flight
  //   - "awaiting":  composition exists, no publish job (stuck or fresh)
  //   - "failed":    last publish attempt errored — show retry button
  //   - null:        no Descript context, OR MP4 already archived
  let descriptRenderState:
    | "processing"
    | "rendering"
    | "awaiting"
    | "failed"
    | null = null;
  if (item.descriptPublishError) {
    descriptRenderState = "failed";
  } else if (item.descriptPublishedAt) {
    descriptRenderState = null;
  } else if (item.descriptPublishJobId) {
    descriptRenderState = "rendering";
  } else if (item.descriptCompositionId) {
    descriptRenderState = "awaiting";
  }
  // Live-status overlay: the column-derived states above only flip after
  // results land back on the production_item row. The window between
  // "click" and "compositionId stamped" (precise-cut import +
  // descript-clip-resolve poll) is invisible to those columns, and the
  // Underlord layout-pack phase (compositionId set, no publishJobId yet)
  // would otherwise render as "Awaiting render" with a misleading
  // "Render now" button. Drive a unified "processing" state from the
  // descript-status poll for every in-flight phase except the MP4 render
  // itself (which has its own "rendering" copy + the existing
  // descript_publish_job_id signal).
  let descriptProcessingLabel: string | null = null;
  let descriptProcessingDetail: string | null = null;
  const liveStatus = descriptStatusLive?.status ?? null;
  const liveTaskId =
    descriptStatusLive?.queueJob?.taskIdentifier ?? null;
  const liveLockedAt = descriptStatusLive?.queueJob?.lockedAt ?? null;
  // Promote to "processing" when descript-status says work is in flight,
  // AS LONG AS the MP4 render hasn't started (the column-derived
  // "rendering" state owns that window — its copy is more accurate). The
  // "stalled" status (project_id set, no composition_id yet) is also
  // surfaced here so users see an in-flight pill instead of a misleading
  // "Awaiting render" button.
  const isPublishRender =
    descriptRenderState === "rendering" || descriptRenderState === "failed";
  if (
    !isPublishRender &&
    (liveStatus === "processing" || liveStatus === "stalled")
  ) {
    descriptRenderState = "processing";
    if (liveTaskId === "clip-idea-precise-cut") {
      // Two sub-phases: import (no compositionId yet) vs Underlord
      // layout-pack (compositionId set, layoutJobId in payload). The
      // queueJob doesn't expose layoutJobId here, but `compositionId`
      // presence is a perfect proxy.
      if (descriptStatusLive?.compositionId) {
        descriptProcessingLabel = "Underlord is applying the layout pack…";
        descriptProcessingDetail =
          "Usually 30–90 seconds. The video will appear here automatically.";
      } else {
        descriptProcessingLabel = liveLockedAt
          ? "Trimming clip locally + uploading to Descript…"
          : "Trimming clip queued — about to start.";
        descriptProcessingDetail =
          "Underlord layout pack will follow once Descript finishes the import.";
      }
    } else if (liveTaskId === "descript-clip-resolve") {
      descriptProcessingLabel = "Cutting clip in Descript (Underlord)…";
      descriptProcessingDetail =
        "Usually 30–90 seconds. The video will appear here automatically.";
    } else if (liveTaskId === "descript-publish-and-archive") {
      // Publish-and-archive is queued (typically with a small settle
      // delay after Underlord finishes) but no descript_publish_job_id
      // is stamped on the item yet. Render the placeholder as
      // "rendering" so the user doesn't see the "Awaiting render" button
      // pop in for a few seconds during the settle window.
      descriptRenderState = "rendering";
    } else {
      descriptProcessingLabel = "Working on your clip in Descript…";
      descriptProcessingDetail =
        "Hang tight — the video will appear here automatically when it's ready.";
    }
  }
  const hideDerivativeSections =
    derivatives.length === 0 && repurposeTargets.length === 0;

  // Clip Ideas needs the full video archived to S3 (so precise-cut can
  // ffmpeg-trim it) and a transcript (so Claude has something to read).
  // Missing either one = show the tab grayed out with a tooltip, not gone.
  const clipIdeasDisabledReason = (() => {
    const missing: string[] = [];
    if (!item.mediaS3Key) missing.push("the full video archived to S3");
    if (!data.transcript) missing.push("a transcript");
    if (missing.length === 0) return null;
    return `Needs ${missing.join(" and ")}.`;
  })();

  // Which tabs are actually applicable for this item's current state. Each
  // tab appears only when its underlying section would render content. If
  // the URL asks for a tab that isn't available (e.g. ?tab=derivatives on a
  // pre-publish item), fall back to the Details tab.
  const availableTabs: {
    value: DetailTab;
    label: string;
    count: number | null;
    disabled?: boolean;
    disabledReason?: string;
  }[] = [
    { value: "details", label: "Details", count: null },
    // Preview tab: hidden for pre-publish post types that have inline
    // drafting (the simulator is rendered inside the Details tab) and for
    // published items (post is live; nothing to simulate). Still useful
    // for pre-publish non-inline items (LinkedIn / YouTube / TikTok / etc.)
    // until inline-draft is built for them too.
    ...(isPrePublish && !isPrePublishInline
      ? ([{ value: "preview", label: "Preview", count: null }] as const)
      : []),
    ...(!isPrePublish &&
    (!hideDerivativeSections ||
      data.reposts.length > 0 ||
      data.crossPosts.length > 0)
      ? ([
          {
            value: "derivatives",
            label: "Derivatives",
            count:
              derivatives.length +
              data.reposts.length +
              data.crossPosts.length,
          },
        ] as const)
      : []),
    // Cross-post / Repost tabs — embed the same triage UI the hot queue
    // uses, so picking targets / assigning happens inline instead of in a
    // modal. Surfaced whenever the underlying actions are eligible
    // (`canCrossPost` / `canRepost` mirror the same gate the Actions menu
    // checks; same disabledReason copy).
    {
      value: "cross-post",
      label: "Cross-post",
      count: data.crossPosts.length || null,
      disabled: data.item.canCrossPost === false,
      disabledReason:
        data.item.canCrossPost === false
          ? "Source has no archived video yet — re-run enrichment or upload manually."
          : undefined,
    },
    {
      value: "repost",
      label: "Repost",
      count: data.reposts.length || null,
      disabled: data.item.canRepost === false,
      disabledReason:
        data.item.canRepost === false
          ? "Source has no archived video yet — re-run enrichment or upload manually."
          : undefined,
    },
    {
      value: "clip-ideas",
      label: "Clip Ideas",
      count: null,
      disabled: !!clipIdeasDisabledReason,
      disabledReason: clipIdeasDisabledReason ?? undefined,
    },
    ...(!isPrePublish && !hideDerivativeSections
      ? ([{ value: "repurpose", label: "Repurpose", count: repurposeTargets.length }] as const)
      : []),
  ];
  const activeTab: DetailTab = (() => {
    const match = availableTabs.find((t) => t.value === activeTabParam);
    if (!match || match.disabled) return "details";
    return activeTabParam;
  })();

  // Resolve the currently-selected editor for the trigger display. Prefer the
  // freshly-loaded assignable list (stays in sync with local selections), and
  // fall back to the detail endpoint's authoritative record so we still render
  // name + avatar even if the user isn't in the list.
  const editorUser = editorUserId
    ? assignableUsers.find((u) => u.id === editorUserId) ??
      (data.editor?.id === editorUserId ? data.editor : null)
    : null;
  const currentFormat =
    data.formats.find((f) => f.name === item.format) ?? null;
  const formatPrompt = currentFormat?.instructions ?? null;
  const notionUrl = item.notionId
    ? `https://www.notion.so/${item.notionId.replace(/-/g, "")}`
    : null;

  const hasDescriptProject = !!item.descriptProjectId;

  return (
    <div className="space-y-6">
      {/* Header. The "← Content" back link is rendered by `<SectionTabs>`
       *  in the dashboard layout when the path matches a content-detail
       *  page — keeps the full vertical space of this column for the
       *  title + metadata. */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <CoverImg
              src={coverImageUrl(item)}
              className="w-16 h-10 rounded object-cover shrink-0"
            />
            {/* Title — clicking the heading enters edit mode (so editors
             *  can just type), and a hover-revealed pencil signals the
             *  affordance for users who don't realize the text is clickable.
             *  Both swap the h1 for an Input that matches the heading's
             *  size exactly so the layout doesn't jump.
             *
             *  The `md:text-2xl` is load-bearing — the base Input class
             *  ends with `md:text-sm` which would otherwise shrink the
             *  input on desktop. Tailwind-merge keeps `md:text-2xl` because
             *  it's the same breakpoint and applies later.
             *
             *  YouTube items are non-editable (no click target, no pencil). */}
            <div className="group/title flex items-start gap-2 min-w-0 flex-1">
              {editingTitle ? (
                <Input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    setEditingTitle(false);
                    if ((item.title ?? "") !== title)
                      void persistField({ title });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setTitle(item.title ?? "");
                      setEditingTitle(false);
                    }
                  }}
                  aria-label="Title"
                  placeholder="Untitled"
                  className="border-0 bg-transparent shadow-none h-auto px-0 py-0 text-xl sm:text-2xl md:text-2xl font-semibold leading-tight focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              ) : isYouTube ? (
                <h1 className="text-xl sm:text-2xl font-semibold leading-tight text-foreground min-w-0 break-words">
                  {item.title || (
                    <span className="text-muted-foreground">(Untitled)</span>
                  )}
                </h1>
              ) : (
                <h1
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditingTitle(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setEditingTitle(true);
                    }
                  }}
                  className="text-xl sm:text-2xl font-semibold leading-tight text-foreground min-w-0 break-words cursor-text rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  title="Click to edit"
                >
                  {item.title || (
                    <span className="text-muted-foreground">(Untitled)</span>
                  )}
                </h1>
              )}
              {!isYouTube && !editingTitle && (
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  aria-label="Edit title"
                  title="Edit title"
                  className="mt-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted/50 hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          {/* Identity row — "what is this post?" Account, source-type,
           *  format, editor, status. All chips are clickable: the format /
           *  editor / status chips open the same pickers the sidebar used
           *  to mount, just relocated here so the right column doesn't
           *  carry three dropdowns. */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {/* Account chip — Pattern A. Replaces the static AccountBadge
             *  display; click opens the AccountPostTypePicker. Note this
             *  is now the ONE editing surface for account/postType — the
             *  sidebar's Account row was removed in the same pass. */}
            <AccountPostTypePicker
              accounts={accounts}
              accountId={accountId}
              postType={postType}
              publishedLink={publishedLink || null}
              brandSlug={brand}
              disabled={isYouTube}
              onChange={({ accountId: nextId, postType: nextType }) => {
                setAccountId(nextId);
                setPostType(nextType);
                void persistField({
                  accountId: nextId,
                  postType: nextType,
                });
              }}
              triggerClassName={CHIP_A_BASE}
            />

            {/* Format chip — click opens the brand-format command picker.
             *  Same picker the sidebar Format row used to mount. */}
            <Popover
              open={formatPickerOpen}
              onOpenChange={(open) => {
                setFormatPickerOpen(open);
                if (!open) setFormatSearch("");
              }}
            >
              <PopoverTrigger
                aria-label="Format"
                className={CHIP_A_BASE}
              >
                <span className="truncate max-w-[260px]">
                  {format || (
                    <span className="text-muted-foreground">Select format…</span>
                  )}
                </span>
                <ChevronDownIcon className="size-3 opacity-50 shrink-0" />
              </PopoverTrigger>
              <PopoverContent className="w-96 p-0" align="start">
                <Command>
                  <CommandInput
                    placeholder="Search or create format…"
                    value={formatSearch}
                    onValueChange={setFormatSearch}
                  />
                  <CommandList>
                    {(() => {
                      const trimmed = formatSearch.trim();
                      const exactMatch = brandFormats.some(
                        (f) => f.toLowerCase() === trimmed.toLowerCase(),
                      );
                      const showCreate = trimmed.length > 0 && !exactMatch;
                      return (
                        <>
                          {!showCreate && (
                            <CommandEmpty>No matching format.</CommandEmpty>
                          )}
                          {brandFormats.length > 0 && (
                            <CommandGroup>
                              {format && (
                                <CommandItem
                                  onSelect={() => {
                                    setFormat("");
                                    void persistField({ format: null });
                                    setFormatPickerOpen(false);
                                  }}
                                  className="text-muted-foreground"
                                >
                                  <span className="text-sm">Clear selection</span>
                                </CommandItem>
                              )}
                              {brandFormats.map((f) => (
                                <CommandItem
                                  key={f}
                                  value={f}
                                  onSelect={() => {
                                    setFormat(f);
                                    void persistField({ format: f });
                                    setFormatPickerOpen(false);
                                  }}
                                  data-checked={format === f ? "true" : undefined}
                                >
                                  <span className="text-sm">{f}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                          {showCreate && (
                            <CommandGroup heading="Actions" forceMount>
                              <CommandItem
                                value={`__create__ ${trimmed}`}
                                onSelect={() => void createFormatFromQuery(trimmed)}
                                forceMount
                              >
                                <span className="text-sm">
                                  Create <span className="font-medium">&ldquo;{trimmed}&rdquo;</span>
                                </span>
                              </CommandItem>
                            </CommandGroup>
                          )}
                        </>
                      );
                    })()}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {currentFormat && (
              <Link
                href={`/${brand}/formats/${currentFormat.id}`}
                title="Open format page"
                className="inline-flex h-7 items-center rounded-md px-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
              >
                <ExternalLinkIcon className="size-3" />
              </Link>
            )}

            {/* Editor chip — avatar + name; click opens the user picker
             *  (same options the sidebar Editor Select used to mount). */}
            <Select
              value={editorUserId || ""}
              onValueChange={(v) => {
                if (!v) return;
                setEditorUserId(v);
                void persistField({ editorUserId: v });
              }}
            >
              <SelectTrigger
                aria-label="Editor"
                size="sm"
                className={cn(
                  CHIP_A_BASE,
                  "w-auto [&>span]:flex [&>span]:items-center [&>span]:min-w-0",
                )}
              >
                {editorUser ? (
                  // xs avatar (w-5 h-5) so the chip stays the same h-7
                  // height as Format/Status/Account. The "sm" default
                  // (w-6 h-6) pushes it ~4px taller and breaks the
                  // chip-row alignment.
                  <UserChip user={editorUser} size="xs" />
                ) : (
                  <span className="text-muted-foreground">Select editor</span>
                )}
              </SelectTrigger>
              <SelectContent>
                {assignableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <UserChip user={u} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Status chip — colored pill matching the current status
             *  palette; click opens the same filtered list of status
             *  options the sidebar dropdown used to mount. Published /
             *  Scheduled are still filtered out by `statusOptions` so the
             *  only path to those values is the Publish-or-Schedule
             *  modal. */}
            <Select
              value={status}
              onValueChange={(v) => {
                const prev = status;
                const next = v ?? "";
                if (next === prev) return;
                if (next === "Killed") {
                  setPendingKill({ previousStatus: prev });
                  return;
                }
                setStatus(next);
                void persistField({ status: next || null }).then((ok) => {
                  if (!ok) setStatus(prev);
                });
              }}
            >
              <SelectTrigger
                aria-label="Status"
                size="sm"
                className={cn(
                  CHIP_A_BASE,
                  "w-auto",
                  // Status variant: tint the chip itself rather than wrap
                  // a nested colored pill. Palette helpers return Tailwind
                  // class strings that include border + bg + text — they
                  // override CHIP_A_BASE's neutral defaults via Tailwind's
                  // last-class-wins merge. The chevron stays neutral.
                  status && statusClassWithPalette(status, statusPalette),
                )}
              >
                <SelectValue placeholder="Select status…">
                  {status || null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((s) => (
                  <SelectItem key={s.id} value={s.name}>
                    <span
                      className={cn(
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border",
                        statusClassFromToken(s.color),
                      )}
                    >
                      {s.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Author handle moved into the state row below — it's
             *  read-only source-data, belongs with the other Pattern B
             *  tags rather than alongside the editable identity chips. */}
          </div>

          {/* State row — Pattern B (read-only info tags). Source-type,
           *  pipeline statuses, prediction, reference-post link, and
           *  published date all live here. Each chip uses CHIP_B_BASE
           *  styling — no border, dim text, optional colored dot or
           *  icon. The four pipeline-status components (Descript, Canva,
           *  Transcript, Enrichment) render as chips via their
           *  `variant="chip"` mode so they match. */}
          <div className="flex items-center gap-1 flex-wrap mt-2 text-xs text-muted-foreground">
            {/* Source-type chip — clickable for non-original items, opens
             *  a popover with the Pillar Content + Reposted From pickers
             *  AND the reference-post details that used to live in a
             *  separate state-row chip. Consolidating these three
             *  surfaces (source-type label, Reference post chip, sidebar
             *  picker rows) into one popover removes the redundancy. */}
            {(() => {
              const sourceType =
                (item.sourceType as
                  | "original"
                  | "repost"
                  | "cross_post"
                  | "repurposed"
                  | null) ?? "original";
              const SOURCE_STYLES: Record<
                "original" | "repost" | "cross_post" | "repurposed",
                { label: string; dot: string; description: string }
              > = {
                original: {
                  label: "Original",
                  dot: "bg-emerald-500",
                  description: "Brand-new original content.",
                },
                repost: {
                  label: "Repost",
                  dot: "bg-amber-500",
                  description:
                    "Same content, same platform (any account) — a re-run of an earlier post.",
                },
                cross_post: {
                  label: "Cross-post",
                  dot: "bg-rose-500",
                  description:
                    "Same content, different platform from the original.",
                },
                repurposed: {
                  label: "Repurposed",
                  dot: "bg-sky-500",
                  description:
                    "Derivative of a pillar — clip, short cut, or other format spawned from longer content.",
                },
              };
              const style = SOURCE_STYLES[sourceType];
              const showPillar =
                sourceType === "repost" ||
                sourceType === "cross_post" ||
                sourceType === "repurposed";
              const showRepostedFrom =
                sourceType === "repost" || sourceType === "cross_post";
              const isInteractive = showPillar || showRepostedFrom;
              const referenceHeading =
                sourceType === "cross_post"
                  ? "Cross-posted from"
                  : "Reposted from";

              // Original (or null) → no popover, plain SourceBadge.
              // Nothing to edit; the chip is just a label.
              if (!isInteractive) {
                return <SourceBadge sourceType={sourceType} />;
              }

              return (
                <Popover>
                  <PopoverTrigger
                    className={cn(CHIP_B_BASE, CHIP_B_CLICKABLE)}
                    title={style.description}
                  >
                    <span
                      className={cn("size-1.5 rounded-full", style.dot)}
                      aria-hidden
                    />
                    {style.label}
                  </PopoverTrigger>
                  <PopoverContent className="w-[26rem] space-y-3" align="start">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn("size-1.5 rounded-full", style.dot)}
                          aria-hidden
                        />
                        <span className="text-sm font-medium text-foreground">
                          {style.label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                        {style.description}
                      </p>
                    </div>

                    {showPillar && (
                      <div className="space-y-1.5 border-t border-border/60 pt-3">
                        <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                          Pillar content
                        </p>
                        <PillarPicker
                          brand={brand}
                          excludeId={contentId}
                          value={pillar}
                          onChange={(next) => {
                            setPillar(next);
                            void persistField({
                              pillarContentItemId: next?.id ?? null,
                            });
                          }}
                          triggerClassName="border border-border bg-background shadow-none h-8 px-2 rounded-sm hover:bg-muted/50 w-full"
                        />
                      </div>
                    )}

                    {showRepostedFrom && (
                      <div className="space-y-1.5 border-t border-border/60 pt-3">
                        <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                          {referenceHeading}
                        </p>
                        <PillarPicker
                          brand={brand}
                          excludeId={contentId}
                          value={repostedFromOption}
                          onChange={(next) => {
                            setRepostedFromOption(next);
                            void persistField({
                              repostedFromItemId: next?.id ?? null,
                            });
                          }}
                          placeholder="No source — click to choose…"
                          includeAll
                          triggerClassName="border border-border bg-background shadow-none h-8 px-2 rounded-sm hover:bg-muted/50 w-full"
                        />
                        {/* Reference-post details — same layout the
                         *  removed standalone Reference post chip used.
                         *  Shows when the upstream resolves; gives
                         *  editors the at-a-glance "originally posted X,
                         *  Y views, with reasoning" data without leaving
                         *  this popover. */}
                        {data.repostedFrom && (
                          <div className="mt-2 space-y-1.5">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <Link
                                href={`/${brand}/content/${data.repostedFrom.id}`}
                                className="text-sm font-medium text-foreground hover:text-primary hover:underline"
                              >
                                {data.repostedFrom.title || "(untitled)"}
                              </Link>
                              <span className="text-xs text-muted-foreground">
                                {data.repostedFrom.publishedDate &&
                                  `originally ${formatDate(data.repostedFrom.publishedDate)}`}
                                {data.repostedFrom.views != null && (
                                  <>
                                    {" "}
                                    · {formatCompact(data.repostedFrom.views)} views
                                  </>
                                )}
                              </span>
                            </div>
                            {data.repostedFrom.publishedLink && (
                              <a
                                href={data.repostedFrom.publishedLink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary hover:underline"
                                title="Open the published source post in a new tab"
                              >
                                <ExternalLinkIcon className="size-3.5" /> View published post
                              </a>
                            )}
                            {data.repostedFrom.evergreenReasoning && (
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                <span className="font-medium text-foreground">
                                  Why this was recommended:
                                </span>{" "}
                                {data.repostedFrom.evergreenReasoning}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              );
            })()}
            <DescriptStatusPill productionItemId={item.id} variant="chip" />
            <CanvaStatusPill productionItemId={item.id} initialItem={item} variant="chip" />
            <TranscriptButton
              itemId={item.id}
              hasMedia={!!item.mediaS3Key}
              hasTranscript={data.transcript != null}
              variant="chip"
            />
            {isPrePublish && data.prediction && (
              <Popover>
                <PopoverTrigger
                  className={cn(CHIP_B_BASE, CHIP_B_CLICKABLE)}
                  title="See how this estimate was calculated"
                >
                  {data.prediction.prediction != null ? (
                    <>
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          CONFIDENCE_STYLES[data.prediction.confidence].dot,
                        )}
                        aria-hidden
                      />
                      Est. {formatCompact(data.prediction.prediction)} views
                    </>
                  ) : (
                    <>
                      <TrendingUpIcon className="size-3" /> Est. views
                    </>
                  )}
                </PopoverTrigger>
                <PopoverContent className="w-80 space-y-2" align="end">
                  {data.prediction.prediction != null ? (
                    <>
                      <div className="text-3xl font-bold tabular-nums">
                        {formatCompact(data.prediction.prediction)}
                      </div>
                      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                        Predicted views
                      </div>
                      {data.prediction.p25 != null && data.prediction.p75 != null && (
                        <div className="text-xs text-muted-foreground">
                          Range {formatCompact(data.prediction.p25)} –{" "}
                          {formatCompact(data.prediction.p75)}
                        </div>
                      )}
                      {data.prediction.cohortBreakdown.length > 0 && (() => {
                        const totalN = data.prediction.cohortBreakdown.reduce(
                          (s, c) => s + c.n,
                          0,
                        );
                        return (
                          <div className="text-xs text-muted-foreground">
                            Based on {totalN.toFixed(0)} similar posts
                          </div>
                        );
                      })()}
                      <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border/60 pt-2">
                        Blended estimate using format-cohort median, pillar
                        history, and platform baseline.
                      </p>
                    </>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      Not enough signal yet — assign a format and a pillar to
                      see an estimate.
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
            {/* The standalone Reference post chip + popover was removed
             *  2026-05-15 — its contents moved into the source-type
             *  chip's popover above (PILLAR CONTENT + REPOSTED FROM
             *  sections), since both surfaces were describing the same
             *  lineage. */}
            {isPublished && (
              <EnrichmentButton
                variant="chip"
                itemId={item.id}
                enrichmentCompletedAt={item.enrichmentCompletedAt}
                enrichmentAttempts={item.enrichmentAttempts}
                enrichmentError={item.enrichmentError}
                title={item.title}
                postType={item.postType}
                thumbnail={item.thumbnail}
                publishedAt={item.publishedAt}
                publishedDate={item.publishedDate}
                hook={item.hook}
                hookSource={item.hookSource}
                hookExtractor={item.hookExtractor}
                hookExtractedAt={item.hookExtractedAt}
                overlay={item.overlay}
                coverDescription={item.coverDescription}
                visionExtractedAt={item.visionExtractedAt}
                contentBody={item.contentBody}
                contentBodyFetchedAt={item.contentBodyFetchedAt}
                contentBodySource={item.contentBodySource}
                contentMediaUrl={item.contentMediaUrl}
                description={item.description}
                authorHandle={item.authorHandle}
                authorDisplayName={item.authorDisplayName}
                authorFollowerCount={item.authorFollowerCount}
                authorVerified={item.authorVerified}
                posterUrl={item.posterUrl}
                mediaUrl={item.mediaUrl}
                mediaContentType={item.mediaContentType}
                mediaSizeBytes={item.mediaSizeBytes}
                mediaS3Key={item.mediaS3Key}
                posterS3Key={item.posterS3Key}
                transcriptAudioS3Key={data.transcript?.audioS3Key ?? null}
                transcriptModel={data.transcript?.model ?? null}
                transcriptDurationSec={data.transcript?.durationSec ?? null}
                newsletterPreviewText={item.newsletterPreviewText}
                newsletterBodyHtml={item.newsletterBodyHtml}
                newsletterRecipients={item.newsletterRecipients}
                klaviyoListId={item.klaviyoListId}
                media={data.media}
                onSynced={load}
              />
            )}
            {/* CTA UTM chip — Pattern B. Click opens a small popover
             *  with the same Input + Generate-button wiring the sidebar
             *  CTA UTM row used to mount. Removes the dedicated sidebar
             *  row so the right column can become the activity feed. */}
            <Popover>
              <PopoverTrigger
                className={cn(CHIP_B_BASE, CHIP_B_CLICKABLE)}
                title="CTA UTM campaign — appended to every link in this post's CTAs / reply"
              >
                <LinkIcon className="size-3" />
                {utmCampaign.trim() ? (
                  <span className="font-mono">{utmCampaign.trim()}</span>
                ) : (
                  <span className="italic">No CTA UTM</span>
                )}
              </PopoverTrigger>
              <PopoverContent className="w-80 space-y-2" align="start">
                <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  CTA UTM
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Appended as <code>utm_campaign</code> on every link in
                  this post&apos;s reply CTA. Auto-generated from the
                  title; you can override.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={utmCampaign}
                    onChange={(e) => setUtmCampaign(e.target.value)}
                    onBlur={() => {
                      const next = utmCampaign.trim();
                      if ((item.utmCampaign ?? "") !== next) {
                        void persistField({ utmCampaign: next }).then((ok) => {
                          if (!ok) setUtmCampaign(item.utmCampaign ?? "");
                        });
                      }
                    }}
                    aria-label="CTA UTM campaign"
                    className="h-8 text-xs font-mono flex-1"
                    placeholder="e.g. angus-warner-42"
                  />
                  {!utmCampaign.trim() && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-xs shrink-0"
                      disabled={generatingUtm}
                      onClick={async () => {
                        if (generatingUtm) return;
                        setGeneratingUtm(true);
                        try {
                          const res = await fetch(
                            "/api/production-items/generate-utm",
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ title: item.title ?? "" }),
                            },
                          );
                          const json = await res.json().catch(() => ({}));
                          if (!res.ok || typeof json?.utmCampaign !== "string") {
                            toast.error(json?.error || "Couldn't generate CTA UTM");
                            return;
                          }
                          const slug = json.utmCampaign as string;
                          const ok = await persistField({ utmCampaign: slug });
                          if (ok) setUtmCampaign(slug);
                        } finally {
                          setGeneratingUtm(false);
                        }
                      }}
                    >
                      {generatingUtm ? "Generating…" : "Generate"}
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {/* DM keyword chip — Instagram-only. Click opens a popover
             *  with the existing slug → short-link → destination chain;
             *  Edit button opens AttachDmKeywordDialog (unchanged). */}
            {postType?.startsWith("instagram_") && (
              <Popover>
                <PopoverTrigger
                  className={cn(CHIP_B_BASE, CHIP_B_CLICKABLE)}
                  title="ManyChat DM keyword for this post's auto-reply flow"
                >
                  <LinkIcon className="size-3" />
                  {item.shortLinkSlug ? (
                    <span className="font-mono">{item.shortLinkSlug}</span>
                  ) : (
                    <span className="italic">No DM keyword</span>
                  )}
                </PopoverTrigger>
                <PopoverContent className="w-[26rem] space-y-2" align="start">
                  <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    DM keyword
                  </p>
                  {item.shortLinkSlug ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <code className="px-1.5 py-0.5 rounded bg-muted text-foreground">
                          {item.shortLinkSlug}
                        </code>
                        <span className="text-muted-foreground">→</span>
                        <a
                          href={`${shortLinksBaseUrl}/${item.shortLinkSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-muted-foreground hover:text-foreground hover:underline truncate"
                        >
                          {shortLinksBaseUrl.replace(/^https?:\/\//, "")}/{item.shortLinkSlug}
                        </a>
                      </div>
                      {dmDestinationUrl && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">→</span>
                          <a
                            href={dmDestinationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-foreground/80 hover:text-foreground hover:underline truncate min-w-0 flex-1"
                            title={dmDestinationUrl}
                          >
                            {dmDestinationUrl.replace(/^https?:\/\//, "")}
                          </a>
                        </div>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setDmKeywordDialogOpen(true)}
                      >
                        Edit
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Wires this post into the ManyChat auto-DM flow.
                        When attached, viewers who comment the keyword
                        get a DM with the short link.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setDmKeywordDialogOpen(true)}
                      >
                        + Attach DM keyword
                      </Button>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            )}
            {item.publishedDate && (
              <span className={CHIP_B_BASE}>
                Published {formatDate(item.publishedDate)}
              </span>
            )}
            {(item.authorHandle || item.authorDisplayName) && (
              <span
                className={CHIP_B_BASE}
                title={
                  item.authorFollowerCount != null
                    ? `${item.authorFollowerCount.toLocaleString()} followers at last enrichment`
                    : undefined
                }
              >
                · @{item.authorHandle || item.authorDisplayName}
                {item.authorVerified && (
                  <span className="text-blue-500" aria-label="verified">
                    ✓
                  </span>
                )}
                {item.authorFollowerCount != null && (
                  <span>· {formatCompact(item.authorFollowerCount)} followers</span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {/* Header strip is intentionally lean: one primary CTA + one
           *  catch-all Actions dropdown. All the status pills, info
           *  popovers, and pipeline buttons that used to clutter this
           *  strip moved into the title-area chip rows above. "Open in
           *  Notion" and "Upload source video" moved into the Actions
           *  menu below. */}
          {/* Single path to status='Published'/'Scheduled'. The header CTA
           *  reflects the most useful next action per state:
           *    - Published WITH a published_link → "View Live Post" (anchor,
           *      opens the actual social post). Editing the publish info is
           *      a rare follow-up so it moves into the Actions dropdown.
           *    - Published/Scheduled WITHOUT a link (data issue, or
           *      scheduled-not-yet-posted) → "Edit publish info" stays as
           *      the top-level CTA so the operator can fix it.
           *    - Pre-publish → "Publish or Schedule" primary CTA.
           *  The Edit modal's onSuccess calls `load()` to refetch the row. */}
          {item.status === "Published" && item.publishedLink ? (
            <a
              href={item.publishedLink}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "default", size: "sm" })}
              title="Open the live post on the destination platform"
            >
              <ExternalLinkIcon className="size-3.5" /> View Live Post
            </a>
          ) : item.status === "Published" || item.status === "Scheduled" ? (
            <button
              type="button"
              onClick={() => setPublishDialogOpen(true)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              title="Edit the published link or date for this post"
            >
              <PencilIcon className="size-3.5" /> Edit publish info
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPublishDialogOpen(true)}
              className={buttonVariants({ variant: "default", size: "sm" })}
              title="Mark this post as published (paste the live link) or schedule it for later"
            >
              <UploadIcon className="size-3.5" /> Publish or Schedule
            </button>
          )}
          {(() => {
            const isSyncing = syncState.kind === "syncing";
            return (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  disabled={actionPending}
                  title="Actions for this post"
                >
                  <MoreHorizontalIcon className="size-3.5" /> Actions
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    disabled={item.canCrossPost === false}
                    onClick={() => setActiveTab("cross-post")}
                    title={
                      item.canCrossPost === false
                        ? "Source has no archived video yet — re-run enrichment or upload manually."
                        : "Open the Cross-post tab"
                    }
                  >
                    <Share2Icon className="size-3.5" /> Cross-post to…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={actionPending || item.canRepost === false}
                    onClick={() => setActiveTab("repost")}
                    title={
                      item.canRepost === false
                        ? "Source has no archived video yet — re-run enrichment or upload manually."
                        : "Open the Repost tab"
                    }
                  >
                    <RepeatIcon className="size-3.5" /> Repost
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={actionPending}
                    onClick={() => void handleRedraft()}
                  >
                    <SparklesIcon className="size-3.5" /> Redraft
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={actionPending}
                    onClick={() => void handleDuplicate()}
                  >
                    <CopyIcon className="size-3.5" /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={actionPending}
                    onClick={() => setShowMergeModal(true)}
                  >
                    <GitMerge className="size-3.5" /> Merge…
                  </DropdownMenuItem>
                  {/* Edit publish info — moved into the Actions menu when
                   *  the post is Published with a link, since "View Live
                   *  Post" took the header CTA spot. Only meaningful for
                   *  Published/Scheduled items; pre-publish items use the
                   *  primary "Publish or Schedule" button instead. */}
                  {(item.status === "Published" ||
                    item.status === "Scheduled") && (
                    <DropdownMenuItem
                      onClick={() => setPublishDialogOpen(true)}
                    >
                      <PencilIcon className="size-3.5" /> Edit publish info
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  {!hasDescriptProject && item.mediaS3Key && (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onClick={() => void handleAddToDescript()}
                    >
                      <FilmIcon className="size-3.5" /> Add to Descript
                    </DropdownMenuItem>
                  )}
                  {hasDescriptProject && (
                    <DropdownMenuItem onClick={openDescriptModal}>
                      <RefreshCwIcon className="size-3.5" /> Replace Descript
                      file
                    </DropdownMenuItem>
                  )}
                  {hasDescriptProject && item.descriptCompositionId && (
                    <DropdownMenuItem
                      onClick={() => void handleDownloadFromDescript()}
                    >
                      <DownloadIcon className="size-3.5" /> Download from
                      Descript
                    </DropdownMenuItem>
                  )}
                  {item.mediaS3Key && (
                    <DropdownMenuItem
                      onClick={() => {
                        window.location.href = `/api/uploads/download?itemId=${item.id}`;
                      }}
                    >
                      <DownloadIcon className="size-3.5" /> Download media
                      {item.mediaSizeBytes && (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {(item.mediaSizeBytes / 1024 / 1024).toFixed(1)} MB
                        </span>
                      )}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      window.location.href =
                        "/watermarks/starter-story-watermarks.zip";
                    }}
                  >
                    <DownloadIcon className="size-3.5" /> Download watermarks
                  </DropdownMenuItem>
                  {/* Pre-publish helper for YouTube — uploads the source MP4
                   *  so Whisper can transcribe and clip ideas can fire even
                   *  before the post goes live. Used to be a dedicated
                   *  header button; folded into Actions since it's a rare,
                   *  one-shot trigger per item. */}
                  {isYouTube && !isPublished && !item.mediaS3Key && (
                    <DropdownMenuItem
                      onClick={() => setMediaUploadOpen(true)}
                    >
                      <UploadIcon className="size-3.5" /> Upload source video
                    </DropdownMenuItem>
                  )}
                  {/* Notion deep-link. Used to be a header button; folded
                   *  here so the header strip can stay focused on the
                   *  single primary "Publish or Schedule" CTA. */}
                  {notionUrl && (
                    <DropdownMenuItem
                      onClick={() => window.open(notionUrl, "_blank", "noopener,noreferrer")}
                    >
                      <FileTextIcon className="size-3.5" /> Open in Notion
                    </DropdownMenuItem>
                  )}
                  {isPublished && (
                    <DropdownMenuItem
                      disabled={isSyncing}
                      onClick={() => void handleSync()}
                    >
                      <RefreshCwIcon
                        className={cn(
                          "size-3.5",
                          isSyncing && "animate-spin",
                        )}
                      />
                      {isSyncing ? "Syncing…" : "Sync metrics"}
                    </DropdownMenuItem>
                  )}
                  {(status !== "Killed" || !isYouTube) && (
                    <DropdownMenuSeparator />
                  )}
                  {status !== "Killed" && (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={actionPending}
                      onClick={() =>
                        setPendingKill({ previousStatus: status })
                      }
                    >
                      <SkullIcon className="size-3.5" /> Kill
                    </DropdownMenuItem>
                  )}
                  {!isYouTube && (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={deleting}
                      onClick={() => void handleDelete()}
                    >
                      <Trash2Icon className="size-3.5" />
                      {deleting ? "Deleting…" : "Delete post"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
        </div>
      </div>

      {/* Metrics — only shown once the post is actually live */}
      {isPublished && (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground">
            {item.lastPerformanceSyncAt
              ? `Metrics last synced ${formatRelative(item.lastPerformanceSyncAt)}`
              : "Metrics not yet synced"}
          </p>
          <div className="flex items-center gap-2">
            {syncState.kind === "synced" && (
              <span className="text-[11px] text-green-600">Synced</span>
            )}
            {syncState.kind === "note" && (
              <span
                className="text-[11px] text-muted-foreground"
                title={syncState.message}
              >
                {syncState.message}
              </span>
            )}
            {syncState.kind === "error" && (
              <span
                className="text-[11px] text-red-600"
                title={syncState.message}
              >
                {syncState.message}
              </span>
            )}
          </div>
        </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-4",
          item.predictedViewsSnapshot != null
            ? "md:grid-cols-5"
            : "md:grid-cols-4"
        )}
      >
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Views
          </p>
          <div className="mt-2 flex items-end justify-between gap-3">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.views)}
            </span>
            {data?.viewHistory && data.viewHistory.length >= 2 ? (
              <div title={`${data.viewHistory.length} snapshots`}>
                <ViewsSparkline points={data.viewHistory} height={28} width={120} />
              </div>
            ) : null}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {item.viewsEstimated ? "Estimated from likes" : "Reported"}
          </p>
        </div>
        {(data?.derivatives?.length ?? 0) +
          (data?.reposts?.length ?? 0) +
          (data?.crossPosts?.length ?? 0) >
        0 ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Total Views
            </p>
            <div className="mt-2">
              <span className="text-3xl font-semibold text-foreground tabular-nums">
                {formatCompact(data?.descendantViewsTotal ?? 0)}
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Across derivatives, reposts, and cross-posts
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Comments
            </p>
            <div className="mt-2">
              <span className="text-3xl font-semibold text-foreground tabular-nums">
                {formatCompact(item.comments ?? 0)}
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">On this post</p>
          </div>
        )}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Likes
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.likes)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">On this post</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Clicks
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.clicks)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {item.leads != null
              ? `${item.leads.toLocaleString()} leads`
              : "Link clicks"}
          </p>
        </div>
        {item.predictedViewsSnapshot != null && (
          <PredictedVsActualCard
            predicted={item.predictedViewsSnapshot}
            actual={item.views}
          />
        )}
      </div>
      </div>
      )}

      {/* Content detail tabs — pill style with HubSpot orange active state */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DetailTab)}>
        <TabsList
          className="flex h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0 shadow-none"
        >
          {availableTabs.map((tab) => (
            // Wrap disabled triggers in a span so the native tooltip fires on
            // hover — a disabled <button> swallows mouse events in every
            // browser, which would otherwise suppress the `title` popup.
            <span
              key={tab.value}
              title={tab.disabled ? tab.disabledReason : undefined}
              className="inline-flex"
            >
              <TabsTrigger
                value={tab.value}
                disabled={tab.disabled}
                className={cn(
                  "group/tab flex-initial h-9 rounded-md px-3 text-sm font-medium transition-colors",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                  "data-active:!bg-orange-100 data-active:!text-orange-700 data-active:!shadow-none",
                  "after:!hidden",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
                )}
              >
                <span>{tab.label}</span>
                {tab.count != null && tab.count > 0 && (
                  <span
                    className={cn(
                      "ml-1.5 inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full px-1.5",
                      "text-[10px] font-semibold tabular-nums",
                      "bg-muted text-muted-foreground",
                      "group-data-active/tab:bg-orange-200 group-data-active/tab:text-orange-800",
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </TabsTrigger>
            </span>
          ))}
        </TabsList>

        <TabsContent value="details" className="pt-5 space-y-6">
      <div
        className={
          showLeftPane
            ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start"
            : undefined
        }
      >
      {/* LEFT column. Two cases: pre-publish inline-drafting items get the
       * editable simulator (drafting surface). Published items get a real
       * embed of the live post (Instagram iframe, X/TikTok widget, …). All
       * other states render no left pane and the form goes full-width. */}
      {isPrePublishInline ? (
        <ContentPreview
          item={item}
          media={data.media ?? []}
          draftId={draft?.id ?? null}
          liveContent={liveContent}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          onMediaMutated={() => void load()}
          onDraftMutated={() => void load()}
          descriptRenderState={descriptRenderState}
          descriptProcessingLabel={descriptProcessingLabel}
          descriptProcessingDetail={descriptProcessingDetail}
          draftAlgorithmRunning={draftAlgorithmRunning}
        />
      ) : isPublished ? (
        <PublishedEmbed item={item} />
      ) : null}
      {/* RIGHT column. Used to be the metadata sidebar
       *  (PropertyRowGroups for Published link/date + CTA UTM + DM
       *  keyword). As of 2026-05-15 every one of those rows moved into
       *  title-area chips or the Publish-or-Schedule modal, so the
       *  right column is now the Activity feed itself — cleaner
       *  preview-on-left / activity-on-right layout Pat asked for.
       *  Only renders when there's a left pane; form-only states
       *  (pre-publish non-inline) still get the standalone Activity
       *  below the form. */}
      {showLeftPane && (
        <ContentActivity
          contentId={item.id}
          brand={brand}
          refreshKey={activityRefreshKey}
          statusPalette={statusPalette}
        />
      )}
      {deleteError && (
        <div className="text-sm px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded-md">
          {deleteError}
        </div>
      )}

      {/* Instructions panel: pre-publish only, and not for post types
       * with inline drafting (which already occupy the right-side real
       * estate via the simulator card). */}
      {isPrePublish && !isPrePublishInline && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Instructions
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {currentFormat
                  ? `Instructions for creating "${currentFormat.name}" content.`
                  : "Instructions for creating this content."}
              </p>
            </div>
            {currentFormat && (
              <Link
                href={`/${brand}/formats/${currentFormat.id}`}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Edit
              </Link>
            )}
          </div>
          {formatPrompt ? (
            <div className="whitespace-pre-wrap break-words text-sm text-foreground bg-accent/30 rounded-md p-3 max-h-[600px] overflow-auto">
              {renderInstructions(formatPrompt)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {currentFormat
                ? "No prompt set on this format yet."
                : "This post has no format assigned."}
              {currentFormat && (
                <>
                  {" "}
                  <Link
                    href={`/${brand}/formats/${currentFormat.id}`}
                    className="text-foreground underline"
                  >
                    Add one
                  </Link>
                  .
                </>
              )}
            </div>
          )}

          {/* Top Bangers — highest performing items in this format */}
          {currentFormat && (
            <>
              <div className="border-t border-border pt-4 mt-4">
                <h3 className="text-sm font-semibold text-foreground">
                  Top Bangers In This Format
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Highest performing published content in this format
                </p>
              </div>

              {data?.topPerformers && data.topPerformers.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {data.topPerformers.map((perf) => (
                    <Link
                      href={`/${brand}/content/${perf.id}`}
                      key={perf.id}
                      className="flex gap-3 p-3 rounded border border-border hover:bg-accent/50 transition"
                    >
                      <CoverImg
                        src={coverImageUrl(perf)}
                        alt={perf.title || "Content thumbnail"}
                        className="h-16 w-16 rounded object-cover flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground line-clamp-2">
                          {perf.title || "Untitled"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {perf.views ? formatCompact(perf.views) : "—"} views
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(perf.publishedDate)}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No data available for this format
                </div>
              )}
            </>
          )}
        </div>
      )}
      </div>

      {/* Standalone Activity feed — renders below the form for the
       *  form-only states (pre-publish non-inline post types like
       *  Newsletter). Two-column states (inline drafting + published)
       *  already render Activity in the right column above. */}
      {!showLeftPane && (
        <ContentActivity
          contentId={item.id}
          brand={brand}
          refreshKey={activityRefreshKey}
          statusPalette={statusPalette}
        />
      )}
        </TabsContent>

        {/* Match the tab-trigger gate: only render the Preview tab body
         * for pre-publish non-X items. Pre-publish X renders the
         * simulator inline on the Details tab; published items get no
         * preview at all. */}
        {isPrePublish && !isPrePublishInline && (
          <TabsContent value="preview" className="pt-4">
            <ContentPreview
              item={item}
              media={data.media ?? []}
              draftId={draft?.id ?? null}
              liveContent={liveContent}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              onMediaMutated={() => void load()}
              onDraftMutated={() => void load()}
              descriptRenderState={descriptRenderState}
              descriptProcessingLabel={descriptProcessingLabel}
              descriptProcessingDetail={descriptProcessingDetail}
              draftAlgorithmRunning={draftAlgorithmRunning}
            />
          </TabsContent>
        )}

      {!isPrePublish &&
        (!hideDerivativeSections ||
          data.reposts.length > 0 ||
          data.crossPosts.length > 0) && (
      <TabsContent value="derivatives" className="pt-4 space-y-4">
      {(() => {
        // One merged table: pillar-derivatives + reposts + cross-posts.
        // Sources are labeled with the same badges the Queue uses
        // (Repost / Cross-post); originals and clips get no badge.
        type MergedRow = {
          key: string;
          id: string;
          title: string | null;
          platform: string[] | null;
          postType: string | null;
          account: {
            id: string;
            platform: string;
            handle: string;
            displayName: string | null;
          } | null;
          format: string | null;
          status: string | null;
          publishedDate: string | null;
          publishedLink: string | null;
          views: number | null;
          viewsEstimated: boolean | null;
          likes: number | null;
          comments: number | null;
          depth: number;
          kind: "derivative" | "repost" | "cross_post";
          cover: string | null;
        };
        const mergedRows: MergedRow[] = [
          ...derivatives.map<MergedRow>((d) => ({
            key: `d-${d.id}`,
            id: d.id,
            title: d.title,
            platform: d.platform,
            postType: d.postType ?? null,
            account: d.account ?? null,
            format: d.format,
            status: d.status,
            publishedDate: d.publishedDate,
            publishedLink: d.publishedLink,
            views: d.views,
            viewsEstimated: d.viewsEstimated,
            likes: d.likes,
            comments: d.comments,
            depth: d.depth,
            kind: "derivative",
            cover: coverImageUrl(d),
          })),
          ...data.reposts.map<MergedRow>((r) => ({
            key: `r-${r.id}`,
            id: r.id,
            title: r.title,
            platform: r.platform,
            postType: r.postType ?? null,
            account: r.account ?? null,
            format: null,
            status: r.status,
            publishedDate: r.publishedDate,
            publishedLink: r.publishedLink,
            views: r.views,
            viewsEstimated: r.viewsEstimated,
            likes: r.likes,
            comments: r.comments,
            depth: 1,
            kind: "repost",
            cover: coverImageUrl(r),
          })),
          ...data.crossPosts.map<MergedRow>((c) => ({
            key: `c-${c.id}`,
            id: c.id,
            title: c.title,
            platform: c.platform,
            postType: c.postType ?? null,
            account: c.account ?? null,
            format: null,
            status: c.status,
            publishedDate: c.publishedDate,
            publishedLink: c.publishedLink,
            views: c.views,
            viewsEstimated: c.viewsEstimated,
            likes: c.likes,
            comments: c.comments,
            depth: 1,
            kind: "cross_post",
            cover: coverImageUrl(c),
          })),
        ];
        return (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Derivatives
                  <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                    {mergedRows.length}
                  </span>
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Every downstream piece — pillar derivatives, reposts, and
                  cross-posts — across every status and format.
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-accent/50">
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Title
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Platform
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Format
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Status
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                      Published
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Views
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Likes
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                      Comments
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mergedRows.map((d) => (
                    <tr
                      key={d.key}
                      className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                    >
                      <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                        <div className="flex items-center gap-3">
                          <CoverImg
                            src={d.cover}
                            className="w-20 h-12 rounded object-cover shrink-0"
                          />
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-sm font-medium text-foreground truncate inline-flex items-center gap-1.5">
                              {d.kind === "repost" && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-900 border border-amber-200 shrink-0"
                                  title="Reposting an existing piece of content"
                                >
                                  Repost
                                </span>
                              )}
                              {d.kind === "cross_post" && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-900 border border-indigo-200 shrink-0"
                                  title="Same content syndicated to a different platform"
                                >
                                  Cross-post
                                </span>
                              )}
                              {d.kind === "derivative" && d.depth > 1 && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-accent text-muted-foreground border border-border shrink-0"
                                  title={
                                    d.depth === 2
                                      ? "Grandchild"
                                      : d.depth === 3
                                      ? "Great-grandchild"
                                      : `${d.depth} levels deep`
                                  }
                                >
                                  L{d.depth}
                                </span>
                              )}
                              <Link
                                href={`/${brand}/content/${d.id}`}
                                className="hover:text-primary hover:underline transition-colors truncate"
                              >
                                {d.title || "(Untitled)"}
                              </Link>
                              {d.publishedLink && (
                                <a
                                  href={d.publishedLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted-foreground hover:text-foreground shrink-0"
                                  title="Open published post"
                                  aria-label="Open published post"
                                >
                                  ↗
                                </a>
                              )}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <AccountBadge
                            account={d.account}
                            postType={d.postType}
                            variant="compact"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-sm text-muted-foreground">
                        {d.format || "-"}
                      </td>
                      <td className="px-3 py-2">
                        {d.status ? (
                          <span
                            className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                              statusClassWithPalette(d.status, statusPalette)
                            )}
                          >
                            {d.status}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                        {d.publishedDate
                          ? formatDate(d.publishedDate)
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                        {d.views != null ? (
                          <span
                            title={
                              d.viewsEstimated
                                ? "Estimated from likes"
                                : undefined
                            }
                          >
                            {d.viewsEstimated ? "~" : ""}
                            {d.views.toLocaleString()}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                        {d.likes?.toLocaleString() || "-"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                        {d.comments?.toLocaleString() || "-"}
                      </td>
                    </tr>
                  ))}
                  {mergedRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-12 text-center text-muted-foreground text-sm"
                      >
                        No derivatives, reposts, or cross-posts yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      </TabsContent>
      )}

      <TabsContent value="cross-post" className="pt-4">
        {(() => {
          // Inline panel — same component the hot-queue dialog uses, just
          // dropped straight into the tab body. The candidate is synthesized
          // from the loaded item + brand accounts; hot-queue-only fields
          // (whyHot / hotnessSignals / topSignal) stay undefined so the
          // panel hides the Hot pill + Why-this-is-hot block on this surface.
          const sourceAccount = accounts.find((a) => a.id === item.accountId);
          if (!sourceAccount) {
            return (
              <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                Set an account on this item to cross-post.
              </div>
            );
          }
          const candidateAccount = {
            id: sourceAccount.id,
            platform: sourceAccount.platform,
            handle: sourceAccount.handle,
            displayName: sourceAccount.displayName ?? null,
            avatarUrl: sourceAccount.avatarUrl ?? null,
          };
          const existingCrossPosts = (data.crossPosts ?? []).map((cp) => ({
            productionItemId: cp.id,
            accountId: cp.account?.id ?? "",
            postType: cp.postType ?? null,
            status: cp.status ?? null,
            publishedAt: null,
          }));
          const brandAccountsForPanel: BrandAccount[] = accounts
            .filter((a) => a.brandSlug === brand && a.isActive)
            .map((a) => ({
              id: a.id,
              platform: a.platform,
              handle: a.handle,
              displayName: a.displayName ?? null,
              avatarUrl: a.avatarUrl ?? null,
              syncedFromNotion: a.syncedFromNotion,
            }));
          return (
            <div className="rounded-lg border border-border bg-card p-5">
              <CrossPostTriagePanel
                candidate={{
                  id: item.id,
                  brand,
                  title: item.title ?? null,
                  postType: item.postType ?? "",
                  format: item.format ?? null,
                  account: candidateAccount,
                  existingCrossPosts,
                  publishedLink: item.publishedLink ?? null,
                }}
                brandAccounts={brandAccountsForPanel}
                brand={brand}
                dismissAfterSubmit={false}
                showSourceHeader={false}
                showSecondaryFooter={false}
                onActioned={() => void load()}
              />
            </div>
          );
        })()}
      </TabsContent>

      <TabsContent value="repost" className="pt-4">
        {(() => {
          const sourceAccount = accounts.find((a) => a.id === item.accountId);
          if (!sourceAccount) {
            return (
              <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                Set an account on this item to repost.
              </div>
            );
          }
          const candidateAccount = {
            id: sourceAccount.id,
            platform: sourceAccount.platform,
            handle: sourceAccount.handle,
            displayName: sourceAccount.displayName ?? null,
            avatarUrl: sourceAccount.avatarUrl ?? null,
          };
          return (
            <div className="rounded-lg border border-border bg-card p-5">
              <RepostTriagePanel
                candidate={{
                  id: item.id,
                  title: item.title ?? null,
                  postType: item.postType ?? "",
                  format: item.format ?? null,
                  account: candidateAccount,
                  publishedLink: item.publishedLink ?? null,
                }}
                brand={brand}
                showDismissControls={false}
                showSourceHeader={false}
                showSecondaryFooter={false}
                onActioned={() => void load()}
              />
            </div>
          );
        })()}
      </TabsContent>

      <TabsContent value="clip-ideas" className="pt-4">
        <ClipIdeasPanel itemId={item.id} brand={brand} isAdmin={isAdmin} />
      </TabsContent>

      {!isPrePublish && !hideDerivativeSections && (
      <TabsContent value="repurpose" className="pt-4">
      {/* Create derivative */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Create derivative
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Spawn a new draft in a derivative format. The new item is
              assigned to you and pre-linked to this pillar — fill in the
              details on the new page.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {repurposeTargets.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  createAll(
                    repurposeTargets.map((f) => ({ id: f.id, name: f.name }))
                  )
                }
                disabled={creatingAll}
                title="Create a derivative for every target format, one after another."
                className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creatingAll ? "Creating all…" : "Create all"}
              </button>
            )}
          </div>
        </div>

        {/* Ad-hoc "create in any format" picker. Shows brand formats
         *  that AREN'T in the mapped repurposeTargets table below (those
         *  already have a per-row Create button — surfacing them twice
         *  would be noise). Selecting a format fires the same
         *  createDerivative handler as the mapped rows — same backend
         *  route, same toast, same redirect. Lets the editor try a
         *  one-off repurpose (e.g. → Newsletter) without first adding a
         *  permanent mapping. */}
        {(() => {
          const mappedIds = new Set(repurposeTargets.map((f) => f.id));
          const candidates = (data.formats ?? []).filter(
            (f) => !mappedIds.has(f.id),
          );
          if (candidates.length === 0) return null;
          return (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Create in any format
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Pick any brand format to repurpose this pillar into —
                  same flow as the mapped rows below, but ad-hoc.
                </p>
              </div>
              <Popover
                open={repurposeAnyOpen}
                onOpenChange={(open) => {
                  setRepurposeAnyOpen(open);
                  if (!open) setRepurposeAnySearch("");
                }}
              >
                <PopoverTrigger
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "gap-2",
                  )}
                  disabled={creatingAll}
                >
                  <span>Pick a format…</span>
                  <ChevronDownIcon className="size-3 opacity-50" />
                </PopoverTrigger>
                <PopoverContent className="w-96 p-0" align="end">
                  <Command>
                    <CommandInput
                      placeholder="Search formats…"
                      value={repurposeAnySearch}
                      onValueChange={setRepurposeAnySearch}
                    />
                    <CommandList>
                      <CommandEmpty>No matching format.</CommandEmpty>
                      <CommandGroup>
                        {candidates.map((f) => {
                          const busy = createStatus[f.id] === "creating";
                          return (
                            <CommandItem
                              key={f.id}
                              value={f.name}
                              disabled={busy}
                              onSelect={() => {
                                setRepurposeAnyOpen(false);
                                void createDerivative(f.id, f.name);
                              }}
                            >
                              <span className="text-sm truncate">
                                {f.name}
                              </span>
                              {busy && (
                                <span className="ml-auto text-[10px] text-muted-foreground">
                                  creating…
                                </span>
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          );
        })()}

        {repurposeTargets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repurposed-type formats for this brand yet.{" "}
            <Link
              href={`/${brand}/formats`}
              className="text-primary hover:underline"
            >
              Add a format
            </Link>{" "}
            with content type <span className="font-mono">Repurposed</span> to see it here.
          </p>
        ) : (
          <div className="rounded-md border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Editor</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead className="text-right">Total Views</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repurposeTargets.map((f) => {
                  const busy = createStatus[f.id] === "creating";
                  const editorUser = f.editor
                    ? assignableUsers.find(
                        (u) =>
                          u.name === f.editor ||
                          u.email === f.editor
                      ) ?? null
                    : null;
                  // Every repurposeTarget is a direct child of `item.format`
                  // by construction (the API's `parentFormatId` filter), so
                  // the parent display name is just the item's source format.
                  const parentName = item.format ?? null;
                  const channels = f.accountChannels ?? [];
                  return (
                    <TableRow key={f.id}>
                      <TableCell>
                        <span className="flex items-center gap-2 min-w-0">
                          {parentName && (
                            <>
                              <Link
                                href={`/${brand}/formats/${f.parentFormatId}`}
                                className="text-muted-foreground hover:text-foreground hover:underline truncate max-w-[180px]"
                              >
                                {parentName}
                              </Link>
                              <span className="text-muted-foreground shrink-0">
                                →
                              </span>
                            </>
                          )}
                          <Link
                            href={`/${brand}/formats/${f.id}`}
                            className="font-medium text-foreground hover:underline truncate"
                            title="Edit this format's details"
                          >
                            {f.name}
                          </Link>
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-purple-50 text-purple-700">
                            Derivative
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {channels.slice(0, 3).map((c) => (
                            <AccountBadge
                              key={`${c.accountId}|${c.postType ?? ""}`}
                              account={c.account}
                              postType={c.postType}
                            />
                          ))}
                          {channels.length > 3 && (
                            <span className="text-xs text-muted-foreground">
                              +{channels.length - 3}
                            </span>
                          )}
                          {channels.length === 0 && (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {editorUser ? (
                          <UserChip user={editorUser} size="xs" />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {f.viewThreshold != null
                          ? f.viewThreshold.toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-foreground">
                        {f.totalViews && f.totalViews > 0
                          ? f.totalViews.toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          onClick={() => createDerivative(f.id, f.name)}
                          disabled={busy || creatingAll}
                          title="Create a new draft in this format, assigned to you."
                          className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {busy ? "Creating…" : "Create →"}
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium">Create</span> spawns a new draft in
          that format, assigned to you, linked back to this pillar, and takes
          you to its detail page. If a draft for this pillar+format already
          exists, you&apos;ll be redirected there instead. Click a format
          name to edit its details.
        </p>
      </div>
      </TabsContent>
      )}

      </Tabs>

      {/* Add to Descript modal */}
      <Dialog open={descriptModalOpen} onOpenChange={(o) => { if (!o) closeDescriptModal(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {descriptReplacing ? "Replace Descript project" : "Add to Descript"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-foreground truncate">
                {item.title || "Untitled"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {descriptReplacing
                  ? "Uploads a new file and repoints this post to a fresh Descript project. The previous Descript project is not deleted — it stays in your Descript account."
                  : "Creates a new Descript project for this post so you can clip it into other formats."}
              </p>
            </div>
            {descriptResult ? (
              <>
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-2">
                  <div className="font-medium text-foreground">
                    {descriptReplacing ? "Project replaced." : "Project created."}
                  </div>
                  <a
                    href={descriptResult.projectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {descriptResult.projectUrl}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {descriptMode === "upload"
                      ? "Upload complete. Descript is processing — open the link to watch progress."
                      : "Descript is still importing the video — open the link to watch progress."}
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button variant="outline" onClick={closeDescriptModal}>Close</Button>
                </div>
              </>
            ) : (
              <>
                <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
                  <button
                    type="button"
                    onClick={() => setDescriptMode("upload")}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                      descriptMode === "upload"
                        ? "bg-card text-foreground font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Upload file
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescriptMode("url")}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                      descriptMode === "url"
                        ? "bg-card text-foreground font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Paste URL
                  </button>
                </div>

                {descriptMode === "upload" ? (
                  <div className="space-y-2">
                    <Label htmlFor="descript-file">Video file</Label>
                    <Input
                      id="descript-file"
                      type="file"
                      accept="video/*,audio/*"
                      onChange={(e) => setDescriptFile(e.target.files?.[0] || null)}
                      disabled={descriptStage === "uploading" || descriptStage === "creating"}
                    />
                    {descriptFile && (
                      <p className="text-xs text-muted-foreground">
                        {descriptFile.name} · {(descriptFile.size / (1024 * 1024)).toFixed(1)} MB
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Uploaded directly from your browser to Descript. No middleman.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="descript-url">Video URL</Label>
                    <Input
                      id="descript-url"
                      type="url"
                      value={descriptUrl}
                      onChange={(e) => setDescriptUrl(e.target.value)}
                      placeholder="https://drive.google.com/file/d/…"
                    />
                    <p className="text-xs text-muted-foreground">
                      Google Drive share link (set to &ldquo;anyone with the link&rdquo;), or
                      any public direct-download video URL. YouTube URLs won&apos;t work.
                    </p>
                  </div>
                )}

                {descriptStage === "uploading" && (
                  <div className="space-y-1.5">
                    <div className="w-full bg-border rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full bg-primary transition-all"
                        style={{ width: `${descriptProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Uploading to S3… {descriptProgress}%
                    </p>
                  </div>
                )}

                {descriptError && (
                  <div className="space-y-1">
                    <p className="text-xs text-destructive">{descriptError}</p>
                    {s3KeyForRetry && (
                      <p className="text-[10px] text-muted-foreground">
                        File is uploaded — retry sends it to Descript without re-uploading.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={closeDescriptModal}
                    disabled={descriptStage === "uploading" || descriptStage === "creating"}
                  >
                    Cancel
                  </Button>
                  {s3KeyForRetry && descriptError ? (
                    <Button
                      onClick={retryDescriptImport}
                      disabled={descriptStage === "creating"}
                    >
                      {descriptStage === "creating" ? "Retrying…" : "Retry Descript import"}
                    </Button>
                  ) : (
                  <Button
                    onClick={
                      descriptMode === "upload" ? submitDescriptUpload : submitDescriptUrl
                    }
                    disabled={
                      descriptStage === "creating" ||
                      descriptStage === "uploading" ||
                      (descriptMode === "upload" ? !descriptFile : !descriptUrl.trim())
                    }
                  >
                    {descriptStage === "creating"
                      ? descriptReplacing
                        ? "Replacing…"
                        : "Creating…"
                      : descriptStage === "uploading"
                      ? "Uploading…"
                      : descriptMode === "upload"
                      ? descriptReplacing
                        ? "Upload & replace"
                        : "Upload & create"
                      : descriptReplacing
                      ? "Replace project"
                      : "Create project"}
                  </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mediaUploadOpen}
        onOpenChange={(o) => { if (!o) closeMediaUploadModal(); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload media</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Upload the source video for this post directly to S3. Whisper
              starts transcribing immediately — once that finishes you can
              generate clip ideas, even before the post is published.
            </p>
            {mediaUploadStage === "done" ? (
              <>
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-1">
                  <p className="font-medium text-foreground">Upload complete.</p>
                  <p className="text-xs text-muted-foreground">
                    Whisper is transcribing. Check the Transcript tab in a
                    few minutes; clip-idea generation unlocks once the
                    transcript lands.
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button variant="outline" onClick={closeMediaUploadModal}>
                    Close
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="media-upload-file">Video file</Label>
                  <Input
                    id="media-upload-file"
                    type="file"
                    accept="video/*,audio/*"
                    onChange={(e) =>
                      setMediaUploadFile(e.target.files?.[0] || null)
                    }
                    disabled={
                      mediaUploadStage === "uploading" ||
                      mediaUploadStage === "confirming"
                    }
                  />
                  {mediaUploadFile && (
                    <p className="text-xs text-muted-foreground">
                      {mediaUploadFile.name} · {(mediaUploadFile.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                  )}
                </div>
                {mediaUploadStage === "uploading" && (
                  <div className="space-y-1.5">
                    <div className="w-full bg-border rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full bg-primary transition-all"
                        style={{ width: `${mediaUploadProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Uploading to S3… {mediaUploadProgress}%
                    </p>
                  </div>
                )}
                {mediaUploadStage === "confirming" && (
                  <p className="text-xs text-muted-foreground">
                    Saving and kicking off Whisper…
                  </p>
                )}
                {mediaUploadError && (
                  <p className="text-xs text-destructive">{mediaUploadError}</p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={closeMediaUploadModal}
                    disabled={
                      mediaUploadStage === "uploading" ||
                      mediaUploadStage === "confirming"
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submitMediaUpload}
                    disabled={
                      !mediaUploadFile ||
                      mediaUploadStage === "uploading" ||
                      mediaUploadStage === "confirming"
                    }
                  >
                    {mediaUploadStage === "uploading"
                      ? "Uploading…"
                      : mediaUploadStage === "confirming"
                      ? "Saving…"
                      : "Upload"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <KillIdeaDialog
        open={pendingKill !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKill(null);
        }}
        title={title || item.title || ""}
        saving={saveState.kind === "saving"}
        onConfirm={confirmKill}
      />

      <PublishScheduleDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        itemId={item.id}
        initialLink={item.publishedLink ?? null}
        initialPublishedDate={item.publishedDate ?? null}
        currentStatus={item.status ?? null}
        onSuccess={() => {
          void load();
        }}
      />

      <AttachDmKeywordDialog
        open={dmKeywordDialogOpen}
        onOpenChange={setDmKeywordDialogOpen}
        currentSlug={item.shortLinkSlug ?? null}
        baseUrl={shortLinksBaseUrl}
        onSaved={async (nextSlug) => {
          await persistField({ shortLinkSlug: nextSlug });
          setDmRefresh((k) => k + 1);
        }}
      />

      <MergeModal
        open={showMergeModal}
        onOpenChange={setShowMergeModal}
        primaryItem={item}
        brand={brand}
        contentId={contentId}
        onMergeComplete={() => {
          // Refresh after successful merge
          router.refresh();
        }}
      />

    </div>
  );
}

const CONFIDENCE_STYLES: Record<
  "high" | "med" | "low",
  { label: string; dot: string; text: string }
> = {
  high: {
    label: "High confidence",
    dot: "bg-emerald-500",
    text: "text-emerald-700",
  },
  med: {
    label: "Moderate confidence",
    dot: "bg-amber-500",
    text: "text-amber-700",
  },
  low: {
    label: "Low confidence",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

function PredictedVsActualCard({
  predicted,
  actual,
}: {
  predicted: number;
  actual: number | null;
}) {
  let delta: { pct: number; direction: "over" | "under" } | null = null;
  if (actual != null && predicted > 0) {
    const pct = ((actual - predicted) / predicted) * 100;
    delta = {
      pct: Math.round(pct),
      direction: pct >= 0 ? "over" : "under",
    };
  }
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
        Predicted
      </p>
      <div className="mt-2">
        <span className="text-3xl font-semibold text-foreground tabular-nums">
          {formatCompact(predicted)}
        </span>
      </div>
      <p
        className={cn(
          "mt-3 text-xs",
          delta
            ? delta.direction === "over"
              ? "text-emerald-700"
              : "text-red-600"
            : "text-muted-foreground"
        )}
      >
        {delta
          ? `${delta.pct >= 0 ? "+" : ""}${delta.pct}% vs predicted`
          : "Snapshot at publish"}
      </p>
    </div>
  );
}

interface DescriptStatusResponse {
  status:
    | "connected"
    | "processing"
    | "stuck"
    | "failed"
    | "stalled"
    | "blocked"
    | "not_started";
  detail: string;
  /** Set when `status === "blocked"`. Drives the pill label + the popover
   *  copy. Each reason maps to a user-actionable resolution. */
  blockedReason:
    | "needs_pillar_media"
    | "needs_transcript"
    | "no_segment_match"
    | null;
  /** Pillar id when this item is a derivative (null when item IS the
   *  pillar). Used by the blocked-state pill to deep-link to the pillar. */
  pillarItemId: string | null;
  compositionId: string | null;
  compositionUrl: string | null;
  projectId: string | null;
  projectUrl: string | null;
  trigger: {
    id: string;
    descriptJobId: string | null;
    descriptImportPath: string | null;
  } | null;
  queueJob: {
    id: string;
    taskIdentifier: string;
    attempts: number;
    maxAttempts: number;
    runAt: string;
    lockedAt: string | null;
    lastError: string | null;
  } | null;
  redriveAvailable: boolean;
  publish: {
    state: "idle" | "rendering" | "rendered" | "failed";
    jobId: string | null;
    publishedAt: string | null;
    error: string | null;
  };
}

const DESCRIPT_STATUS_STYLES: Record<
  DescriptStatusResponse["status"],
  { dot: string; label: string; pillClass: string }
> = {
  connected: {
    dot: "bg-emerald-500",
    label: "Descript ready",
    pillClass: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  processing: {
    dot: "bg-amber-500 animate-pulse",
    label: "Descript processing",
    pillClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
  stuck: {
    dot: "bg-red-500",
    label: "Descript stuck",
    pillClass: "border-red-200 bg-red-50 text-red-800",
  },
  failed: {
    dot: "bg-red-500",
    label: "Descript failed",
    pillClass: "border-red-200 bg-red-50 text-red-800",
  },
  stalled: {
    // "stalled" here is the underlying state name (kept stable for the API
    // contract / popover details + redrive button), but the label is the
    // user-visible copy. Earlier copy ("Descript stalled") read as a failure
    // even though it's a normal in-flight state: project_id is set but
    // composition_id hasn't been written yet (typically 30-90s window
    // between cold-import or duplicate-composition kicking off and the
    // resolver task stamping the new composition_id back). Amber + working
    // language matches the actual state.
    dot: "bg-amber-500 animate-pulse",
    label: "Creating composition…",
    pillClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
  blocked: {
    // Generic blocked style; the pill component overrides the label below
    // based on `blockedReason` so the user sees the specific action
    // ("Needs pillar media" vs "Needs transcript" vs "Segment not found").
    dot: "bg-amber-500",
    label: "Descript blocked",
    pillClass: "border-amber-300 bg-amber-50 text-amber-900",
  },
  not_started: {
    dot: "bg-muted-foreground/40",
    label: "Descript not started",
    pillClass: "border-border bg-muted/30 text-muted-foreground",
  },
};

/** Per-blocked-reason labels for the pill. Generic copy "Descript
 *  blocked" never shows in the UI — these specific labels do. */
const BLOCKED_REASON_LABELS: Record<
  "needs_pillar_media" | "needs_transcript" | "no_segment_match",
  string
> = {
  needs_pillar_media: "Needs pillar media",
  needs_transcript: "Needs transcript",
  no_segment_match: "Segment not found",
};

/**
 * Status pill that mirrors the Descript-side state of the production_item:
 * connected (composition exists), processing (queue job running), stuck
 * (lock leaked from a dead worker), failed (max attempts exhausted),
 * stalled (project exists but no composition + no queue job), or
 * not-started. Click to open a popover with details + a "Re-run" button
 * that releases the queue lock and resets attempts. Polls every 10s
 * while the job is processing so the editor sees state transitions
 * without refreshing the page.
 */
function DescriptStatusPill({
  productionItemId,
  variant = "default",
}: {
  productionItemId: string;
  /** "default" = bordered/colored pill (legacy chrome — kept for any
   *  call site that still expects a loud pill). "chip" = Pattern B
   *  (colored dot + dim text, no border) — used in the content-detail
   *  title-area state row to match the rest of the chip system. */
  variant?: "default" | "chip";
}) {
  const [data, setData] = useState<DescriptStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [redriving, setRedriving] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/production-items/${productionItemId}/descript-status`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as DescriptStatusResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [productionItemId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll while processing OR while a publish render is in flight — state
  // transitions (composition_id getting written, lock leaking, MP4 render
  // finishing) deserve the editor seeing the change without refreshing.
  useEffect(() => {
    if (!data) return;
    const shouldPoll =
      data.status === "processing" || data.publish.state === "rendering";
    if (!shouldPoll) return;
    const interval = setInterval(() => void fetchStatus(), 10_000);
    return () => clearInterval(interval);
  }, [data, fetchStatus]);

  const handleSyncFromDescript = useCallback(
    async (force = false) => {
      try {
        const res = await fetch(
          `/api/production-items/${productionItemId}/sync-descript-publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
          },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error("Couldn't start render", {
            description: json?.error || `HTTP ${res.status}`,
          });
          return;
        }
        toast.success("Rendering MP4 in Descript…", {
          description:
            "Takes about 2 minutes. The simulator will update when it lands.",
        });
        await fetchStatus();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Couldn't start render",
        );
      }
    },
    [productionItemId, fetchStatus],
  );

  const handleRedrive = useCallback(async () => {
    setRedriving(true);
    try {
      const res = await fetch(
        `/api/production-items/${productionItemId}/redrive-descript`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Re-run failed", {
          description: json?.error || `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Re-running…", {
        description:
          "The worker will pick this up within a few seconds. Status will refresh automatically.",
      });
      await fetchStatus();
    } finally {
      setRedriving(false);
    }
  }, [productionItemId, fetchStatus]);

  if (loading || !data) return null;
  // Hide entirely for items with no Descript context (e.g. an Original
  // post that never had a clip path). Editors don't need a "not started"
  // pill on every row that doesn't apply.
  if (data.status === "not_started" && !data.trigger && !data.projectId)
    return null;

  const baseStyle = DESCRIPT_STATUS_STYLES[data.status];
  // Blocked: relabel with the per-reason copy so the editor sees the
  // specific action they need to take.
  const blockedLabelOverride =
    data.status === "blocked" && data.blockedReason
      ? BLOCKED_REASON_LABELS[data.blockedReason]
      : null;
  // Override the pill while an MP4 render is in flight or has failed.
  // Without this the pill flips back to "Descript ready" the instant
  // Underlord finishes — even though the editor is still waiting on the
  // MP4 to land in S3 — which is misleading.
  const style =
    data.publish.state === "rendering"
      ? {
          dot: "bg-amber-500 animate-pulse",
          label: "Rendering MP4…",
          pillClass: "border-amber-200 bg-amber-50 text-amber-800",
        }
      : data.publish.state === "failed"
        ? {
            dot: "bg-red-500",
            label: "Render failed",
            pillClass: "border-red-200 bg-red-50 text-red-800",
          }
        : blockedLabelOverride
          ? { ...baseStyle, label: blockedLabelOverride }
          : baseStyle;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          variant === "chip"
            ? cn(CHIP_B_BASE, CHIP_B_CLICKABLE)
            : cn(buttonVariants({ variant: "outline", size: "sm" }), style.pillClass),
        )}
        title={data.detail}
      >
        <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
        {style.label}
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] space-y-3" align="end">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Descript status
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {style.label}
          </p>
          <p className="mt-1 text-xs text-muted-foreground leading-snug">
            {data.detail}
          </p>
          {data.status === "blocked" && data.pillarItemId && (
            // Brand prefix lives in the URL pathname (`/<brand>/content/<id>`).
            // Building the link here avoids threading brand context all the
            // way through to the pill component just for this one affordance.
            <a
              href={(() => {
                const m = window.location.pathname.match(/^\/([^/]+)\/content\//);
                const brand = m?.[1] ?? "starter-story";
                return `/${brand}/content/${data.pillarItemId}`;
              })()}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-900 hover:underline"
            >
              Open pillar →
            </a>
          )}
        </div>
        {data.queueJob && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5 font-mono">
            <div>
              task: <span className="text-foreground">{data.queueJob.taskIdentifier}</span>
            </div>
            <div>
              attempts:{" "}
              <span className="text-foreground">
                {data.queueJob.attempts} / {data.queueJob.maxAttempts}
              </span>
            </div>
            <div>
              run_at:{" "}
              <span className="text-foreground">
                {new Date(data.queueJob.runAt).toLocaleString()}
              </span>
            </div>
            {data.queueJob.lockedAt && (
              <div>
                locked_at:{" "}
                <span className="text-foreground">
                  {new Date(data.queueJob.lockedAt).toLocaleString()}
                </span>
              </div>
            )}
            {data.queueJob.lastError && (
              <div className="text-red-600 break-words whitespace-pre-wrap">
                error: {data.queueJob.lastError}
              </div>
            )}
          </div>
        )}
        {data.publish.state !== "idle" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Render</span>
              {data.publish.state === "rendering" && (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                  Rendering MP4… (~2 min)
                </span>
              )}
              {data.publish.state === "rendered" && (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  Rendered ✓
                  {data.publish.publishedAt &&
                    ` ${new Date(data.publish.publishedAt).toLocaleString()}`}
                </span>
              )}
              {data.publish.state === "failed" && (
                <span className="inline-flex items-center gap-1 text-red-700">
                  <span className="size-1.5 rounded-full bg-red-500" />
                  Render failed
                </span>
              )}
            </div>
            {data.publish.state === "failed" && data.publish.error && (
              <div className="text-red-700 break-words whitespace-pre-wrap">
                {data.publish.error}
              </div>
            )}
            {(data.publish.state === "failed" ||
              data.publish.state === "rendered") &&
              data.compositionId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    void handleSyncFromDescript(data.publish.state === "failed")
                  }
                >
                  {data.publish.state === "failed"
                    ? "Retry render"
                    : "Re-sync from Descript"}
                </Button>
              )}
          </div>
        )}
        {(data.compositionUrl || data.projectUrl) && (
          <div className="flex flex-col gap-1 text-xs">
            {data.compositionUrl && (
              <a
                href={data.compositionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLinkIcon className="size-3" /> Open composition in Descript
              </a>
            )}
            {data.projectUrl && !data.compositionUrl && (
              <a
                href={data.projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLinkIcon className="size-3" /> Open project in Descript
              </a>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchStatus()}
            disabled={redriving}
          >
            Refresh
          </Button>
          {data.redriveAvailable && (
            <Button
              type="button"
              size="sm"
              onClick={handleRedrive}
              disabled={redriving}
            >
              {redriving ? "Re-running…" : "Re-run"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Small pill that surfaces Canva autofill state on the content-detail page.
 * Renders nothing when no Canva fields are set on the item (most posts).
 *
 *   - autofillJobId set, no editUrl: "Creating in Canva…" with amber pulse;
 *     polls /api/production-items/{id} every 5s until the URL appears.
 *   - editUrl set: green "Open in Canva" link button — opens the autofilled
 *     design in a new tab.
 */
function CanvaStatusPill({
  productionItemId,
  initialItem,
  variant = "default",
}: {
  productionItemId: string;
  initialItem: ProductionItem;
  /** "default" = legacy bold dual-button (Open in Canva + Download all)
   *  / colored pill. "chip" = Pattern B — single dim chip with a colored
   *  dot, opens the same actions via popover. Used in the title-area
   *  state row. */
  variant?: "default" | "chip";
}) {
  const [state, setState] = useState({
    jobId: initialItem.canvaAutofillJobId ?? null,
    designId: initialItem.canvaDesignId ?? null,
    editUrl: initialItem.canvaEditUrl ?? null,
  });

  // Poll while autofill is in flight (job id set, no URL yet). Stops as soon
  // as the URL lands — the canva-create-copy worker task is the only writer.
  useEffect(() => {
    if (state.editUrl) return;
    if (!state.jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/production-items/${productionItemId}`);
        if (!res.ok) return;
        const json = (await res.json()) as { item: ProductionItem };
        if (cancelled) return;
        setState({
          jobId: json.item.canvaAutofillJobId ?? null,
          designId: json.item.canvaDesignId ?? null,
          editUrl: json.item.canvaEditUrl ?? null,
        });
      } catch {
        // Silent — next tick will retry. Editors don't need a toast for a
        // transient network blip while waiting on Canva.
      }
    };
    const interval = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [productionItemId, state.jobId, state.editUrl]);

  if (state.editUrl) {
    if (variant === "chip") {
      // Pattern B: collapse the dual buttons into a single chip with a
      // popover that holds the two actions. Keeps the title-area state
      // row visually consistent.
      return (
        <Popover>
          <PopoverTrigger
            className={cn(CHIP_B_BASE, CHIP_B_CLICKABLE)}
            title="Canva design ready"
          >
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            Canva ready
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="end">
            <a
              href={state.editUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
            >
              <ExternalLinkIcon className="size-3.5" /> Open in Canva
            </a>
            <a
              href={`/api/production-items/${productionItemId}/media/zip`}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
            >
              <DownloadIcon className="size-3.5" /> Download all slides
            </a>
          </PopoverContent>
        </Popover>
      );
    }
    return (
      <>
        <a
          href={state.editUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 hover:text-emerald-900",
          )}
          title="Open the autofilled Canva design in a new tab"
        >
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          Open in Canva
          <ExternalLinkIcon className="size-3.5" />
        </a>
        <a
          href={`/api/production-items/${productionItemId}/media/zip`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          title="Download every slide of the Canva slideshow as a zip"
        >
          <DownloadIcon className="size-3.5" />
          Download all
        </a>
      </>
    );
  }
  if (state.jobId) {
    if (variant === "chip") {
      return (
        <span
          className={CHIP_B_BASE}
          title="Canva is generating the autofilled design"
        >
          <span
            className="size-1.5 rounded-full bg-amber-500 animate-pulse"
            aria-hidden
          />
          Canva creating…
        </span>
      );
    }
    return (
      <span
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "border-amber-200 bg-amber-50 text-amber-800 cursor-default",
        )}
        title="Canva is generating the autofilled design"
      >
        <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden />
        Creating in Canva…
      </span>
    );
  }
  return null;
}

interface TypefullyStatusResponse {
  status:
    | "published"
    | "scheduled"
    | "draft"
    | "publishing"
    | "creating"
    | "stuck"
    | "error"
    | "not_started";
  detail: string;
  postType: string | null;
  accountConfigured: boolean;
  alreadyPublished: boolean;
  draftId: number | null;
  shareUrl: string | null;
  privateUrl: string | null;
  scheduledDate: string | null;
  publishedAt: string | null;
  error: string | null;
  queueJob: {
    id: string;
    taskIdentifier: string;
    attempts: number;
    maxAttempts: number;
    runAt: string;
    lockedAt: string | null;
    lastError: string | null;
  } | null;
  redriveAvailable: boolean;
}

const TYPEFULLY_STATUS_STYLES: Record<
  TypefullyStatusResponse["status"],
  { dot: string; label: string; pillClass: string }
> = {
  draft: {
    dot: "bg-sky-500",
    label: "Typefully draft",
    pillClass: "border-sky-200 bg-sky-50 text-sky-800",
  },
  scheduled: {
    dot: "bg-amber-500",
    label: "Typefully scheduled",
    pillClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
  publishing: {
    dot: "bg-amber-500 animate-pulse",
    label: "Typefully publishing",
    pillClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
  published: {
    dot: "bg-emerald-500",
    label: "Typefully published",
    pillClass: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  creating: {
    dot: "bg-muted-foreground/60 animate-pulse",
    label: "Typefully creating…",
    pillClass: "border-border bg-muted/30 text-muted-foreground",
  },
  stuck: {
    dot: "bg-red-500",
    label: "Typefully stuck",
    pillClass: "border-red-200 bg-red-50 text-red-800",
  },
  error: {
    dot: "bg-red-500",
    label: "Typefully error",
    pillClass: "border-red-200 bg-red-50 text-red-800",
  },
  not_started: {
    dot: "bg-sky-500",
    label: "Create Typefully draft",
    pillClass: "border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100",
  },
};

/**
 * Status pill for the Typefully draft auto-created when an X/LinkedIn item
 * is inserted with no publishedLink. Polls every 10s while the draft is
 * being created or publishing; otherwise relies on the webhook receiver
 * to keep the underlying row fresh between page loads. Hidden when no
 * draft exists and no queue job is in flight (e.g. accounts without
 * typefullySocialSetId).
 */
function TypefullyStatusPill({ productionItemId }: { productionItemId: string }) {
  const [data, setData] = useState<TypefullyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [redriving, setRedriving] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/production-items/${productionItemId}/typefully-status`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as TypefullyStatusResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [productionItemId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!data) return;
    if (data.status !== "creating" && data.status !== "publishing") return;
    const interval = setInterval(() => void fetchStatus(), 10_000);
    return () => clearInterval(interval);
  }, [data, fetchStatus]);

  const handleRedrive = useCallback(async () => {
    setRedriving(true);
    try {
      const res = await fetch(
        `/api/production-items/${productionItemId}/typefully-redrive`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Create / re-run failed", {
          description: json?.error || `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Creating in Typefully…", {
        description:
          "The worker will pick this up within a few seconds. Status will refresh automatically.",
      });
      await fetchStatus();
    } finally {
      setRedriving(false);
    }
  }, [productionItemId, fetchStatus]);

  if (loading || !data) return null;
  // Hide entirely when the owning account isn't mapped to a Typefully social
  // set — the task would silently no-op, so rendering a "Create draft" CTA
  // would mislead. Configure the account's typefully_social_set_id to enable.
  if (!data.accountConfigured) return null;

  // Pre-create state for X/LinkedIn items: render a one-click button
  // (no popover) that just kicks off creation. Less friction than a
  // popover for the common "I want a Typefully draft" path. Hidden for
  // already-published posts — no point drafting a post that's already
  // live on the platform.
  if (
    data.status === "not_started" &&
    !data.queueJob &&
    !data.draftId &&
    !data.alreadyPublished
  ) {
    const style = TYPEFULLY_STATUS_STYLES.not_started;
    return (
      <button
        type="button"
        onClick={handleRedrive}
        disabled={redriving}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          style.pillClass,
        )}
        title="Create a Typefully draft for this post"
      >
        <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
        {redriving ? "Creating…" : style.label}
      </button>
    );
  }

  const style = TYPEFULLY_STATUS_STYLES[data.status];
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          style.pillClass,
        )}
        title={data.detail}
      >
        <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
        {style.label}
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] space-y-3" align="end">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Typefully status
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {style.label}
          </p>
          <p className="mt-1 text-xs text-muted-foreground leading-snug">
            {data.detail}
          </p>
        </div>
        {(data.scheduledDate || data.publishedAt) && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            {data.publishedAt && (
              <div>
                Published:{" "}
                <span className="text-foreground">
                  {new Date(data.publishedAt).toLocaleString()}
                </span>
              </div>
            )}
            {data.scheduledDate && !data.publishedAt && (
              <div>
                Scheduled:{" "}
                <span className="text-foreground">
                  {new Date(data.scheduledDate).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
        {data.queueJob && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5 font-mono">
            <div>
              task: <span className="text-foreground">{data.queueJob.taskIdentifier}</span>
            </div>
            <div>
              attempts:{" "}
              <span className="text-foreground">
                {data.queueJob.attempts} / {data.queueJob.maxAttempts}
              </span>
            </div>
            <div>
              run_at:{" "}
              <span className="text-foreground">
                {new Date(data.queueJob.runAt).toLocaleString()}
              </span>
            </div>
            {data.queueJob.lockedAt && (
              <div>
                locked_at:{" "}
                <span className="text-foreground">
                  {new Date(data.queueJob.lockedAt).toLocaleString()}
                </span>
              </div>
            )}
            {data.queueJob.lastError && (
              <div className="text-red-600 break-words whitespace-pre-wrap">
                error: {data.queueJob.lastError}
              </div>
            )}
          </div>
        )}
        {(data.privateUrl || data.shareUrl) && (
          <div className="flex flex-col gap-1 text-xs">
            {data.privateUrl && (
              <a
                href={data.privateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLinkIcon className="size-3" /> Open in Typefully
              </a>
            )}
            {data.shareUrl && (
              <a
                href={data.shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLinkIcon className="size-3" /> Public share link
              </a>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchStatus()}
            disabled={redriving}
          >
            Refresh
          </Button>
          {data.redriveAvailable && (
            <Button
              type="button"
              size="sm"
              onClick={handleRedrive}
              disabled={redriving}
            >
              {redriving ? "Re-running…" : "Re-run"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
