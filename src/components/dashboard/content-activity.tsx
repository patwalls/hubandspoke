"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import parse, {
  domToReact,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import {
  CheckIcon,
  ChevronRight,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilmIcon,
  Send as SendIcon,
  Wrench as WrenchIcon,
  SparklesIcon,
  ScissorsIcon,
  FishIcon,
  EyeIcon,
  GaugeIcon,
  LayersIcon,
  StarIcon,
  ShuffleIcon,
  CloudIcon,
  DatabaseIcon,
  ImageIcon,
  FilmIcon as VideoIcon,
  TrashIcon,
  MoveHorizontalIcon,
  CodeIcon,
  PaletteIcon,
  type LucideIcon,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import dynamic from "next/dynamic";
import { isEditorEmpty } from "@/lib/comments/editor-empty";

// Dynamic: the editor drags the whole TipTap/ProseMirror bundle (~900 KB
// chunk) — loading it lazily takes it off the detail page's critical path.
// ssr:false is correct anyway (ProseMirror is DOM-only). The placeholder
// mirrors the editor's collapsed height so the comment box doesn't jump.
const CommentEditor = dynamic(
  () =>
    import("@/components/dashboard/comment-editor").then(
      (m) => m.CommentEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[38px] rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
        Loading editor…
      </div>
    ),
  },
);
import { statusClassWithPalette } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

// Activity-feed display helpers. Used by the per-event rendering to
// keep rows scannable when the underlying payload would otherwise dump
// an unreadable UUID, a multi-line URL, or a YYYY-MM-DD string into the
// flow. Pure functions — no React, no state, no formatting opinions
// beyond what's needed to make a single line of activity legible.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidValue(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isUrlish(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
}

// Squash a URL into "host/short-path" form so the activity row stays a
// single readable line. Preserves the host (which carries the platform
// signal) and the first 18 path chars so distinct posts on the same
// host don't all collapse to the same string. Falls back to the raw
// string when URL parsing fails.
function truncateUrl(s: string): string {
  try {
    const u = new URL(s);
    const path = u.pathname.length > 20
      ? u.pathname.slice(0, 18) + "…"
      : u.pathname;
    return u.host + path;
  } catch {
    return s;
  }
}

// "2026-05-15" → "May 15, 2026". Strict — only fires when isIsoDate
// returned true. Anything else passes through untouched.
function formatIsoDate(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo, d));
  if (isNaN(date.getTime())) return s;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface ActivityUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

interface CommentItem {
  kind: "comment";
  id: string;
  createdAt: string;
  editedAt: string | null;
  body: string;
  user: ActivityUser | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  isMine: boolean;
}

type ToolActionPayload = {
  type: "tool_action";
  tool: string;
  action: string;
  status: "success" | "error" | "info";
  label: string;
  url: string | null;
  meta?: Record<string, string | number | null>;
};

// Discriminated source for `content_changed` events. Keep in sync with
// `ContentChangeSource` in src/lib/db/schema.ts.
type ContentChangeSource =
  | { kind: "user" }
  | { kind: "algorithm"; name: string }
  | { kind: "tool"; tool: "descript" | "canva" | "typefully" }
  | { kind: "sync"; system: "notion" | "account-content" | "metrics" }
  | { kind: "import" }
  | { kind: "api" };

type ContentChangeTarget =
  | { kind: "production_item_field"; field: string }
  | {
      kind: "draft_field";
      draftId: string;
      version: number;
      field: string;
    }
  | {
      kind: "media_added" | "media_removed";
      mediaId: string;
      index: number;
      mediaKind: "image" | "video";
      s3Key: string | null;
      posterS3Key: string | null;
    }
  | {
      kind: "media_reordered";
      mediaId: string;
      fromIndex: number;
      toIndex: number;
    };

type ContentChangedPayload = {
  type: "content_changed";
  source: ContentChangeSource;
  target: ContentChangeTarget;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
  truncated?: boolean;
};

type EventPayload =
  | { type: "status_change"; from: string | null; to: string | null }
  | { type: "killed"; from: string | null; reason: string | null }
  | { type: "editor_change"; from: string | null; to: string | null }
  | {
      type: "cross_post_created";
      sourceItemId: string;
      sourceTitle: string | null;
      targetAccountHandle: string | null;
      targetPostType: string | null;
    }
  | {
      type: "repost_created";
      sourceItemId: string;
      sourceTitle: string | null;
    }
  | {
      type: "item_created";
      source: string;
      format: string | null;
      sourceType: string;
      postType: string | null;
    }
  | ContentChangedPayload
  | ToolActionPayload;

// Registry for `tool_action` events. Key on the `tool` string the worker
// emits. Adding a new tool integration = one row here. An unknown tool
// falls back to the generic Wrench icon — safe under deploy ordering.
const TOOL_REGISTRY: Record<
  string,
  { label: string; Icon: LucideIcon; accent: string }
> = {
  descript: { label: "Descript", Icon: FilmIcon, accent: "text-purple-600" },
  typefully: { label: "Typefully", Icon: SendIcon, accent: "text-blue-600" },
  zernio: { label: "TikTok", Icon: SendIcon, accent: "text-rose-600" },
};
const TOOL_FALLBACK = { label: "Tool", Icon: WrenchIcon, accent: "text-muted-foreground" };

// Registry for named algorithms that emit `content_changed` events under
// `source: { kind: "algorithm", name }`. Activity feed renders the badge
// (icon + label + accent) in place of a user avatar. Adding a new algo =
// one row here.
const ALGORITHM_REGISTRY: Record<
  string,
  { label: string; Icon: LucideIcon; accent: string }
> = {
  "draft-algorithm": { label: "Draft Algorithm", Icon: SparklesIcon, accent: "text-violet-600" },
  "slice-algorithm": { label: "Slice Algorithm", Icon: ScissorsIcon, accent: "text-orange-600" },
  "hook-extractor": { label: "Hook Extractor", Icon: FishIcon, accent: "text-cyan-600" },
  "vision-extractor": { label: "Vision Extractor", Icon: EyeIcon, accent: "text-emerald-600" },
  "threshold-monitor": { label: "Threshold Monitor", Icon: GaugeIcon, accent: "text-amber-600" },
  "clip-idea-generator": { label: "Clip Idea Generator", Icon: LayersIcon, accent: "text-pink-600" },
  "evergreen-classifier": { label: "Evergreen Classifier", Icon: StarIcon, accent: "text-lime-600" },
  "cross-post-classifier": { label: "Cross-Post Classifier", Icon: ShuffleIcon, accent: "text-sky-600" },
  enrichment: { label: "Enrichment", Icon: PaletteIcon, accent: "text-fuchsia-600" },
};
const ALGORITHM_FALLBACK = { label: "Algorithm", Icon: SparklesIcon, accent: "text-muted-foreground" };

// Sync-source badges (Notion sync, metrics refresh, account content sync).
const SYNC_REGISTRY: Record<
  string,
  { label: string; Icon: LucideIcon; accent: string }
> = {
  notion: { label: "Notion Sync", Icon: CloudIcon, accent: "text-slate-600" },
  "account-content": { label: "Account Sync", Icon: DatabaseIcon, accent: "text-slate-600" },
  metrics: { label: "Metrics Refresh", Icon: GaugeIcon, accent: "text-slate-600" },
};
const SYNC_FALLBACK = { label: "Sync", Icon: CloudIcon, accent: "text-muted-foreground" };

const IMPORT_BADGE = { label: "Imported", Icon: DatabaseIcon, accent: "text-muted-foreground" };
const API_BADGE = { label: "API", Icon: CodeIcon, accent: "text-muted-foreground" };

/** Resolve a discriminated `ContentChangeSource` to its display badge.
 *  Returns null for `{ kind: "user" }` — those use the actor avatar. */
function badgeForSource(
  source: ContentChangeSource,
): { label: string; Icon: LucideIcon; accent: string } | null {
  if (source.kind === "user") return null;
  if (source.kind === "algorithm") {
    return ALGORITHM_REGISTRY[source.name] ?? ALGORITHM_FALLBACK;
  }
  if (source.kind === "tool") {
    return TOOL_REGISTRY[source.tool] ?? TOOL_FALLBACK;
  }
  if (source.kind === "sync") {
    return SYNC_REGISTRY[source.system] ?? SYNC_FALLBACK;
  }
  if (source.kind === "import") return IMPORT_BADGE;
  return API_BADGE;
}

/** Human-readable labels for `production_item_field.field` strings.
 *  Falls through to the raw key when not listed — safer than throwing. */
const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  hook: "Hook",
  overlay: "Overlay text",
  description: "Description",
  coverDescription: "Cover description",
  contentBody: "Content body",
  format: "Format",
  accountId: "Account",
  postType: "Post type",
  publishedLink: "Published link",
  publishedDate: "Published date",
  pillarContentItemId: "Pillar",
  repostedFromItemId: "Reposted from",
  utmCampaign: "UTM campaign",
  shortLinkSlug: "Short link slug",
  authorHandle: "Author handle",
  authorDisplayName: "Author name",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

interface EventItem {
  kind: "event";
  id: string;
  createdAt: string;
  eventType: string;
  payload: EventPayload;
  user: ActivityUser | null;
}

type ActivityItem = CommentItem | EventItem;

/** A run of events fired by the same actor inside ~60 seconds.
 *  Rendered as one row in the feed: avatar + primary event header,
 *  plus indented secondary lines for the rest. Picked by `groupItems`
 *  below — only fires when at least one `content_changed` /
 *  `status_change` event is in the run (item-creation / kill / repost-
 *  created stand alone). */
interface EventGroup {
  kind: "group";
  /** The headline event — palette-colored status_change wins; otherwise
   *  the first event in the run. */
  primary: EventItem;
  /** Everything else in the run, in their original chronological order.
   *  Renders as a small indented list below the primary. */
  rest: EventItem[];
}

type FeedItem = ActivityItem | EventGroup;

/** A run of 3+ consecutive identical events (same type + same user) collapsed
 *  into a single row with a count and an expand toggle. */
interface CollapsedRun {
  kind: "collapsed";
  /** Representative event (the first one) — used for avatar + description. */
  representative: EventItem;
  /** All items in the run (already grouped by groupItems). */
  items: FeedItem[];
}

type DisplayItem = FeedItem | CollapsedRun;

/** Extract a stable key that identifies "what kind of event" a FeedItem is,
 *  used to detect consecutive identical events for collapsing. */
function feedItemKey(item: FeedItem): string {
  if (item.kind === "comment") return `comment:${item.id}`;
  const ev = item.kind === "group" ? item.primary : item;
  const p = ev.payload;
  if (p.type === "tool_action") return `tool_action:${p.tool}:${p.action}`;
  if (p.type === "content_changed") {
    const t = p.target;
    const field = t.kind === "production_item_field" || t.kind === "draft_field" ? t.field : t.kind;
    return `content_changed:${field}`;
  }
  return p.type;
}

function feedItemUser(item: FeedItem): string | null {
  if (item.kind === "comment") return item.user?.id ?? null;
  if (item.kind === "group") return item.primary.user?.id ?? null;
  return item.user?.id ?? null;
}

function representativeEvent(item: FeedItem): EventItem | null {
  if (item.kind === "comment") return null;
  if (item.kind === "group") return item.primary;
  return item;
}

/** Second-pass collapse: after groupItems, fold consecutive runs of 3+
 *  identical event types (same user) into a single CollapsedRun row. */
function collapseRuns(items: FeedItem[]): DisplayItem[] {
  const MIN_RUN = 3;
  // Event types that should never be collapsed (milestone-style events)
  const NEVER_COLLAPSE = new Set(["item_created", "repost_created", "cross_post_created", "killed", "status_change"]);

  const result: DisplayItem[] = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i];
    const key = feedItemKey(current);
    const userId = feedItemUser(current);
    const rep = representativeEvent(current);

    // Don't collapse comments, or milestone events
    const payloadType = rep?.payload.type ?? "";
    if (!rep || NEVER_COLLAPSE.has(payloadType)) {
      result.push(current);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (feedItemKey(next) !== key) break;
      if (feedItemUser(next) !== userId) break;
      j++;
    }

    const run = items.slice(i, j);
    if (run.length >= MIN_RUN) {
      result.push({ kind: "collapsed", representative: rep, items: run });
    } else {
      result.push(...run);
    }
    i = j;
  }
  return result;
}

/** Walk the chronologically-ordered visibleItems and produce a feed
 *  where bursts of related events (publish action → status + link +
 *  date all in one tx) render as one row. Single events that don't fit
 *  any group pass through untouched. */
function groupItems(items: ActivityItem[]): FeedItem[] {
  const STAND_ALONE: ReadonlySet<string> = new Set([
    "item_created",
    "repost_created",
    "cross_post_created",
    "killed",
  ]);
  const result: FeedItem[] = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i];
    if (current.kind !== "event" || STAND_ALONE.has(current.payload.type)) {
      result.push(current);
      i++;
      continue;
    }
    const group: EventItem[] = [current];
    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (next.kind !== "event") break;
      if (STAND_ALONE.has(next.payload.type)) break;
      if ((next.user?.id ?? null) !== (current.user?.id ?? null)) break;
      const dtMs = Math.abs(
        new Date(next.createdAt).getTime() -
          new Date(current.createdAt).getTime(),
      );
      if (dtMs > 60_000) break;
      group.push(next);
      j++;
    }
    if (group.length > 1) {
      const primary =
        group.find((g) => g.payload.type === "status_change") ??
        group.find((g) => g.payload.type === "editor_change") ??
        group[0];
      const rest = group.filter((g) => g !== primary);
      result.push({ kind: "group", primary, rest });
    } else {
      result.push(current);
    }
    i = j;
  }
  return result;
}

interface ContentActivityProps {
  contentId: string;
  /** Brand slug — used to render the source-item back-link on
   *  `cross_post_created` events. Routes are brand-scoped under
   *  `/<brand>/content/<id>`. */
  brand: string;
  // Bump to trigger a refetch (e.g. after the parent saves a status change).
  refreshKey?: number;
  /** Map<status name, color token> for the brand. Threaded from the parent
   *  so status_change chips render with the same colors as elsewhere. */
  statusPalette?: ReadonlyMap<string, string>;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function userDisplayName(user: ActivityUser | null, fallback: string): string {
  if (!user) return fallback;
  if (user.name && user.name.trim()) return user.name;
  return user.email.split("@")[0] ?? user.email;
}

function commentDisplayName(comment: CommentItem): string {
  if (comment.user) return userDisplayName(comment.user, "Deleted user");
  if (comment.authorName && comment.authorName.trim()) return comment.authorName;
  return "Deleted user";
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name[0] ?? "?").toUpperCase();
}

const MARKDOWN_LINK_CLASS =
  "text-blue-600 underline hover:text-blue-700 break-all";

// Replace `<img>` and file-link `<a>` nodes with React components that
// add download / copy buttons. Everything else falls through to the
// default HTML→React mapping.
const COMMENT_HTML_OPTIONS: HTMLReactParserOptions = {
  replace: (node) => {
    if (node.type !== "tag") return undefined;
    if (node.name === "img") {
      const src = (node.attribs?.src as string | undefined) ?? "";
      const alt = (node.attribs?.alt as string | undefined) ?? "";
      if (!src) return undefined;
      return <CommentImage src={src} alt={alt} />;
    }
    if (node.name === "a") {
      const href = (node.attribs?.href as string | undefined) ?? "";
      // Only intercept links pointing at our file proxy — external
      // links keep the default rendering (they're real pages, not
      // downloadable artifacts).
      if (href.startsWith("/api/files/")) {
        return (
          <CommentFileLink href={href}>
            {domToReact(node.children as DOMNode[], COMMENT_HTML_OPTIONS)}
          </CommentFileLink>
        );
      }
    }
    return undefined;
  },
};

function CommentBody({ body }: { body: string }) {
  const isHtml = body.trimStart().startsWith("<");
  if (isHtml) {
    return (
      <div className="tiptap mt-0.5 text-sm text-foreground break-words space-y-2 leading-relaxed">
        {parse(body, COMMENT_HTML_OPTIONS)}
      </div>
    );
  }
  return (
    <div className="mt-0.5 text-sm text-foreground break-words space-y-2 leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className={MARKDOWN_LINK_CLASS}
            />
          ),
          p: ({ ...props }) => <p {...props} className="whitespace-pre-wrap" />,
          ul: ({ ...props }) => (
            <ul {...props} className="list-disc pl-5 space-y-0.5" />
          ),
          ol: ({ ...props }) => (
            <ol {...props} className="list-decimal pl-5 space-y-0.5" />
          ),
          h1: ({ ...props }) => (
            <h1 {...props} className="text-base font-semibold" />
          ),
          h2: ({ ...props }) => (
            <h2 {...props} className="text-sm font-semibold" />
          ),
          h3: ({ ...props }) => (
            <h3 {...props} className="text-sm font-semibold" />
          ),
          code: ({ ...props }) => (
            <code
              {...props}
              className="bg-accent px-1 py-0.5 rounded text-xs font-mono"
            />
          ),
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className="border-l-2 border-border pl-3 text-muted-foreground"
            />
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

// Hover overlay with download + copy actions. Clipboard API requires a
// user gesture and a same-origin fetch — both true here since /api/files
// runs on our domain. Falls back gracefully on browsers that don't
// support ClipboardItem (e.g. Firefox without the flag).
function CommentImage({ src, alt }: { src: string; alt: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCopy = async () => {
    setError(null);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Some browsers reject formats other than image/png. Convert if
      // needed — but most of our uploads are png/jpeg, so try direct
      // first and only re-encode on failure.
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
      } catch {
        const png = await blobToPng(blob);
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": png }),
        ]);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Copy failed");
      setTimeout(() => setError(null), 2500);
    }
  };

  const downloadUrl = src.includes("?")
    ? `${src}&download=1`
    : `${src}?download=1`;

  return (
    <span className="relative inline-block group/img my-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="rounded border border-border max-w-full sm:max-w-sm h-auto block"
      />
      <span className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
        <a
          href={downloadUrl}
          download={alt || true}
          className={buttonVariants({ variant: "outline", size: "icon-xs" })}
          title="Download"
          aria-label="Download image"
        >
          <DownloadIcon />
        </a>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={onCopy}
          title={copied ? "Copied" : "Copy image"}
          aria-label="Copy image to clipboard"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </span>
      {error && (
        <span className="absolute bottom-2 right-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">
          {error}
        </span>
      )}
    </span>
  );
}

// Browsers (notably Safari) only accept image/png for navigator.clipboard.write
// reliably. Re-encode arbitrary blobs through a canvas so the copy still works
// for jpeg / webp / etc.
async function blobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not supported");
  ctx.drawImage(bitmap, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}

function CommentFileLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const downloadUrl = href.includes("?") ? `${href}&download=1` : `${href}?download=1`;
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={MARKDOWN_LINK_CLASS}
      >
        {children}
      </a>
      <a
        href={downloadUrl}
        download
        className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
        title="Download"
        aria-label="Download file"
      >
        <DownloadIcon />
      </a>
    </span>
  );
}

export function ContentActivity({ contentId, brand, refreshKey = 0, statusPalette }: ContentActivityProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const tempCounter = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(
          `/api/production-items/${contentId}/activity`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: ActivityItem[] };
        if (!cancelled) setItems(data.items);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load activity");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentId, refreshKey]);

  const submit = useCallback(async () => {
    const body = draft;
    if (isEditorEmpty(body) || posting) return;
    const tempId = `temp-${++tempCounter.current}`;
    const optimistic: CommentItem = {
      kind: "comment",
      id: tempId,
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      user: null,
      authorName: null,
      authorAvatarUrl: null,
      isMine: true,
    };
    setItems((prev) => [...prev, optimistic]);
    setDraft("");
    setPosting(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        comment: Omit<CommentItem, "kind">;
      };
      const real: CommentItem = { kind: "comment", ...data.comment };
      setItems((prev) => prev.map((c) => (c.id === tempId ? real : c)));
    } catch (e) {
      setItems((prev) => prev.filter((c) => c.id !== tempId));
      setDraft(body);
      setError(e instanceof Error ? e.message : "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }, [draft, posting, contentId]);

  const startEdit = (c: CommentItem) => {
    setEditingId(c.id);
    setEditDraft(c.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const body = editDraft;
    if (isEditorEmpty(body) || savingEdit) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/comments/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { comment: Omit<CommentItem, "kind"> };
      const real: CommentItem = { kind: "comment", ...data.comment };
      setItems((prev) => prev.map((c) => (c.id === editingId ? real : c)));
      cancelEdit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update comment");
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this comment?")) return;
    const prev = items;
    setItems((cs) => cs.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setItems(prev);
      setError(e instanceof Error ? e.message : "Failed to delete comment");
    }
  };

  // System-change toggle: hides cron / algorithm / tool / sync writes by
  // default so the feed stays tame on items with chatty cron history.
  // Editor preference, persisted in localStorage per user (no server
  // round-trip). Comments and human edits always show.
  const [showSystem, setShowSystem] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        "hubandspoke:activity:show-system",
      );
      if (stored === "true") setShowSystem(true);
    } catch {
      // localStorage may be unavailable (SSR, private mode) — default to
      // hidden is the safest user experience.
    }
  }, []);
  const toggleShowSystem = () => {
    setShowSystem((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          "hubandspoke:activity:show-system",
          String(next),
        );
      } catch {
        // ignore — toggle still works in-session
      }
      return next;
    });
  };
  // Dedupe filter: any `content_changed` event that targets the
  // `status` field is redundant — the publish flow / PUT route writes
  // BOTH a content_changed[status] row AND a dedicated status_change
  // event in the same tx. The status_change one renders the
  // palette-colored chips (the visual Pat likes); the content_changed
  // one is plain text. Dropping the duplicate here means both publish
  // routes can keep their dual-emission for downstream consumers
  // without polluting the feed.
  const dedupedItems: ActivityItem[] = items.filter(
    (item) =>
      item.kind !== "event" ||
      item.payload.type !== "content_changed" ||
      item.payload.target.kind !== "production_item_field" ||
      item.payload.target.field !== "status",
  );

  // Filter only `content_changed` events whose source.kind is non-user.
  // All other event variants (status_change, item_created, tool_action,
  // killed, repost_created, …) stay visible regardless — they're already
  // editorially meaningful by their existence.
  const hiddenSystemCount = dedupedItems.filter(
    (item) =>
      item.kind === "event" &&
      item.payload.type === "content_changed" &&
      item.payload.source.kind !== "user",
  ).length;
  const visibleItems = showSystem
    ? dedupedItems
    : dedupedItems.filter(
        (item) =>
          item.kind !== "event" ||
          item.payload.type !== "content_changed" ||
          item.payload.source.kind === "user",
      );

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Activity</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Comments, content edits, and tool integrations as this post moves through review.
          </p>
        </div>
        {hiddenSystemCount > 0 && (
          <button
            type="button"
            onClick={toggleShowSystem}
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            title="Toggle system-generated changes (cron enrichment, AI regenerates, sync writes)"
          >
            {showSystem
              ? "Hide system changes"
              : `Show system changes (${hiddenSystemCount})`}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {loading && !hasLoaded ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : visibleItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Start the discussion.
          </p>
        ) : (
          collapseRuns(groupItems(visibleItems)).map((item) => {
            if (item.kind === "collapsed") {
              return (
                <CollapsedRunRow
                  key={`collapsed-${item.representative.id}`}
                  run={item}
                  brand={brand}
                  statusPalette={statusPalette}
                />
              );
            }
            if (item.kind === "comment") {
              return (
                <CommentRow
                  key={item.id}
                  comment={item}
                  editingId={editingId}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                  savingEdit={savingEdit}
                  onStartEdit={startEdit}
                  onCancelEdit={cancelEdit}
                  onSaveEdit={saveEdit}
                  onRemove={remove}
                />
              );
            }
            if (item.kind === "event") {
              return (
                <EventRow
                  key={item.id}
                  event={item}
                  brand={brand}
                  statusPalette={statusPalette}
                />
              );
            }
            // Grouped events (publish action, batch field edit, …)
            return (
              <GroupedEventRow
                key={item.primary.id}
                group={item}
                brand={brand}
                statusPalette={statusPalette}
              />
            );
          })
        )}
      </div>

      <div className="pt-2 border-t border-border space-y-2">
        <CommentEditor
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          placeholder="Write a comment…"
          disabled={posting}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            <kbd className="font-mono">⌘</kbd>/<kbd className="font-mono">Ctrl</kbd> +{" "}
            <kbd className="font-mono">Enter</kbd> to post
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={posting || isEditorEmpty(draft)}
            size="sm"
          >
            {posting ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CommentRowProps {
  comment: CommentItem;
  editingId: string | null;
  editDraft: string;
  setEditDraft: (v: string) => void;
  savingEdit: boolean;
  onStartEdit: (c: CommentItem) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRemove: (id: string) => void;
}

function CommentRow({
  comment: c,
  editingId,
  editDraft,
  setEditDraft,
  savingEdit,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
}: CommentRowProps) {
  const avatarUrl = c.user?.avatarUrl ?? c.authorAvatarUrl;
  const name = commentDisplayName(c);
  return (
    <div className="group flex gap-3">
      {avatarUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={avatarUrl}
          alt=""
          className="size-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="size-8 rounded-full bg-accent text-muted-foreground text-xs font-medium inline-flex items-center justify-center shrink-0">
          {initialsFor(name)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{timeAgo(c.createdAt)}</span>
          {c.editedAt && (
            <span className="text-xs text-muted-foreground italic">(edited)</span>
          )}
          {c.isMine && editingId !== c.id && (
            <span className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => onStartEdit(c)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onRemove(c.id)}
                className="text-xs text-red-600 hover:text-red-700"
              >
                Delete
              </button>
            </span>
          )}
        </div>
        {editingId === c.id ? (
          <div className="mt-2 space-y-2">
            <CommentEditor
              value={editDraft}
              onChange={setEditDraft}
              onSubmit={onSaveEdit}
              disabled={savingEdit}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={onSaveEdit}
                disabled={savingEdit || isEditorEmpty(editDraft)}
              >
                {savingEdit ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onCancelEdit}
                disabled={savingEdit}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <CommentBody body={c.body} />
        )}
      </div>
    </div>
  );
}

function EventRow({
  event,
  brand,
  statusPalette,
}: {
  event: EventItem;
  brand: string;
  statusPalette?: ReadonlyMap<string, string>;
}) {
  const actorName = userDisplayName(event.user, "Someone");
  const avatarUrl = event.user?.avatarUrl ?? null;
  // Tool actions get a tool-branded icon avatar instead of the actor's
  // photo — the actor is still named in the body, but the visual anchor
  // is the integration that fired (Descript / Typefully / …).
  const isToolAction = event.payload.type === "tool_action";
  const tool = isToolAction
    ? TOOL_REGISTRY[(event.payload as ToolActionPayload).tool] ?? TOOL_FALLBACK
    : null;
  // content_changed with a non-user source: render the source badge
  // (algorithm / tool / sync / import / api) in place of an avatar.
  // User-sourced content_changed events fall through to the avatar.
  const sourceBadge =
    event.payload.type === "content_changed" &&
    event.payload.source.kind !== "user"
      ? badgeForSource(event.payload.source)
      : null;
  return (
    <div className="flex gap-3 items-center">
      {tool ? (
        <div
          className={cn(
            "size-8 rounded-full bg-accent inline-flex items-center justify-center shrink-0",
            tool.accent,
          )}
        >
          <tool.Icon className="size-4" />
        </div>
      ) : sourceBadge ? (
        <div
          className={cn(
            "size-8 rounded-full bg-accent inline-flex items-center justify-center shrink-0",
            sourceBadge.accent,
          )}
          title={sourceBadge.label}
        >
          <sourceBadge.Icon className="size-4" />
        </div>
      ) : avatarUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={avatarUrl}
          alt=""
          className="size-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="size-8 rounded-full bg-accent text-muted-foreground text-xs font-medium inline-flex items-center justify-center shrink-0">
          {initialsFor(actorName)}
        </div>
      )}
      <div className="min-w-0 flex-1 text-sm text-muted-foreground">
        <EventBody actorName={actorName} event={event} brand={brand} statusPalette={statusPalette} />{" "}
        <span className="text-xs">· {timeAgo(event.createdAt)}</span>
      </div>
    </div>
  );
}

/** Render a burst of related events (e.g. a publish action that
 *  emitted status_change + content_changed[publishedLink] +
 *  content_changed[publishedDate] in one tx) as a single row with the
 *  headline event up top and the rest indented below.
 *
 *  Visually: standard EventRow for the primary (carries the avatar +
 *  timestamp), then a small left-bordered list of EventBody renders
 *  for each secondary event. Secondary lines still mention the actor
 *  name, which is mildly redundant — Pat can ask for a `compactInGroup`
 *  EventBody variant later if it reads noisy. */
function GroupedEventRow({
  group,
  brand,
  statusPalette,
}: {
  group: EventGroup;
  brand: string;
  statusPalette?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="space-y-1.5">
      <EventRow
        event={group.primary}
        brand={brand}
        statusPalette={statusPalette}
      />
      <ul className="ml-11 space-y-1 border-l border-border/60 pl-3 text-xs text-muted-foreground">
        {group.rest.map((ev) => (
          <li key={ev.id} className="leading-snug">
            <EventBody
              actorName={userDisplayName(ev.user, "Someone")}
              event={ev}
              brand={brand}
              statusPalette={statusPalette}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollapsedRunRow({
  run,
  brand,
  statusPalette,
}: {
  run: CollapsedRun;
  brand: string;
  statusPalette?: ReadonlyMap<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { representative: rep, items } = run;
  const actorName = userDisplayName(rep.user, "Someone");
  const avatarUrl = rep.user?.avatarUrl ?? null;
  const isToolAction = rep.payload.type === "tool_action";
  const tool = isToolAction
    ? TOOL_REGISTRY[(rep.payload as ToolActionPayload).tool] ?? TOOL_FALLBACK
    : null;
  const sourceBadge =
    rep.payload.type === "content_changed" && rep.payload.source.kind !== "user"
      ? badgeForSource(rep.payload.source)
      : null;

  const firstDate = timeAgo(rep.createdAt);
  const lastItem = items[items.length - 1];
  const lastEvent = lastItem.kind === "group" ? lastItem.primary : lastItem.kind === "event" ? lastItem : null;
  const lastDate = lastEvent ? timeAgo(lastEvent.createdAt) : null;
  const dateRange = lastDate && lastDate !== firstDate ? `${firstDate} – ${lastDate}` : firstDate;

  return (
    <div className="space-y-2">
      <div className="flex gap-3 items-center">
        {tool ? (
          <div className={cn("size-8 rounded-full bg-accent inline-flex items-center justify-center shrink-0", tool.accent)}>
            <tool.Icon className="size-4" />
          </div>
        ) : sourceBadge ? (
          <div className={cn("size-8 rounded-full bg-accent inline-flex items-center justify-center shrink-0", sourceBadge.accent)} title={sourceBadge.label}>
            <sourceBadge.Icon className="size-4" />
          </div>
        ) : avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={avatarUrl} alt="" className="size-8 rounded-full object-cover shrink-0" />
        ) : (
          <div className="size-8 rounded-full bg-accent text-muted-foreground text-xs font-medium inline-flex items-center justify-center shrink-0">
            {initialsFor(actorName)}
          </div>
        )}
        <div className="min-w-0 flex-1 text-sm text-muted-foreground">
          <EventBody actorName={actorName} event={rep} brand={brand} statusPalette={statusPalette} />{" "}
          <span className="text-xs">· {items.length}×</span>{" "}
          <span className="text-xs">· {dateRange}</span>
          {" "}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? "Collapse" : `Show all ${items.length}`}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="ml-11 space-y-2 border-l border-border/60 pl-3">
          {items.map((item, idx) => {
            if (item.kind === "event") {
              return <EventRow key={item.id} event={item} brand={brand} statusPalette={statusPalette} />;
            }
            if (item.kind === "group") {
              return <GroupedEventRow key={item.primary.id} group={item} brand={brand} statusPalette={statusPalette} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

function EventBody({
  actorName,
  event,
  brand,
  statusPalette,
}: {
  actorName: string;
  event: EventItem;
  brand: string;
  statusPalette?: ReadonlyMap<string, string>;
}) {
  if (event.payload.type === "status_change") {
    const { from, to } = event.payload;
    return (
      <span>
        <span className="font-medium text-foreground">{actorName}</span> changed
        status
        {from ? (
          <>
            {" "}
            from <StatusChip label={from} palette={statusPalette} />
          </>
        ) : null}{" "}
        to {to ? <StatusChip label={to} palette={statusPalette} /> : <em>none</em>}
      </span>
    );
  }
  if (event.payload.type === "editor_change") {
    const { from, to } = event.payload;
    if (!from && to) {
      return (
        <span>
          <span className="font-medium text-foreground">{actorName}</span> added{" "}
          <span className="font-medium text-foreground">{to}</span> as the editor
        </span>
      );
    }
    return (
      <span>
        <span className="font-medium text-foreground">{actorName}</span> changed
        editor
        {from ? (
          <>
            {" "}
            from <span className="font-medium text-foreground">{from}</span>
          </>
        ) : null}{" "}
        to{" "}
        {to ? (
          <span className="font-medium text-foreground">{to}</span>
        ) : (
          <em>none</em>
        )}
      </span>
    );
  }
  if (event.payload.type === "cross_post_created") {
    const { sourceItemId, sourceTitle, targetAccountHandle, targetPostType } =
      event.payload;
    return (
      <span>
        <span className="font-medium text-foreground">{actorName}</span> created
        this from the cross-post queue
        {targetAccountHandle ? (
          <>
            {" "}for{" "}
            <span className="font-medium text-foreground">
              @{targetAccountHandle}
            </span>
            {targetPostType ? (
              <span className="text-muted-foreground"> · {targetPostType}</span>
            ) : null}
          </>
        ) : null}
        {sourceTitle ? (
          <>
            . Source:{" "}
            <Link
              href={`/${brand}/content/${sourceItemId}`}
              className="text-primary hover:underline"
            >
              {sourceTitle}
            </Link>
          </>
        ) : null}
      </span>
    );
  }
  if (event.payload.type === "repost_created") {
    const { sourceItemId, sourceTitle } = event.payload;
    return (
      <span>
        <span className="font-medium text-foreground">{actorName}</span> created
        this from the repost queue
        {sourceTitle ? (
          <>
            . Source:{" "}
            <Link
              href={`/${brand}/content/${sourceItemId}`}
              className="text-primary hover:underline"
            >
              {sourceTitle}
            </Link>
          </>
        ) : null}
      </span>
    );
  }
  if (event.payload.type === "killed") {
    const { reason } = event.payload;
    return (
      <div className="space-y-1">
        <span>
          <span className="font-medium text-foreground">{actorName}</span> killed
          this idea
        </span>
        {reason ? (
          <div className="rounded border-l-2 border-border pl-2 text-sm italic text-muted-foreground">
            &ldquo;{reason}&rdquo;
          </div>
        ) : null}
      </div>
    );
  }
  if (event.payload.type === "tool_action") {
    return <ToolActionBody actor={actorName} payload={event.payload} />;
  }
  if (event.payload.type === "content_changed") {
    return (
      <ContentChangedBody
        actorName={actorName}
        payload={event.payload}
      />
    );
  }
  if (event.payload.type === "item_created") {
    const { source, format, sourceType, postType } = event.payload;
    const sourceLabel = SOURCE_LABELS[source] ?? source;
    const detailParts: string[] = [];
    if (sourceType && sourceType !== "original") detailParts.push(sourceType);
    if (postType) detailParts.push(postType);
    const detail = detailParts.length > 0 ? ` (${detailParts.join(" · ")})` : "";
    return (
      <span>
        <span className="font-medium text-foreground">{actorName}</span> created
        this item via{" "}
        <span className="font-mono text-[12px] text-muted-foreground">
          {sourceLabel}
        </span>
        {detail}
        {format ? (
          <>
            {" · "}format{" "}
            <span className="font-medium text-foreground">{format}</span>
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span>
      <span className="font-medium text-foreground">{actorName}</span> logged{" "}
      {event.eventType}
    </span>
  );
}

// Pretty labels for the `source` string emitted by recordItemCreated.
// Unknown sources fall through to the raw string — safer than throwing
// when a new insert site lands before this map gets updated.
const SOURCE_LABELS: Record<string, string> = {
  "api:create": "Add Post dialog",
  "api:repost": "Repost flow",
  "api:cross-post": "Cross-post flow",
  "api:repurpose": "Repurpose flow",
  "api:duplicate": "Duplicate action",
  "sync:account-content": "Account content sync",
  "sync:notion": "Notion sync",
  "cron:threshold-monitor-sweep": "Auto-repurpose (cron)",
  "service:clip-promote": "Clip promotion",
  "service:clip-promote-full": "Clip promotion (full video)",
  "service:clip-idea-generate": "Clip idea pipeline",
  "legacy:descript-clip-out": "Descript clip-out (legacy)",
};

function ToolActionBody({
  actor,
  payload,
}: {
  actor: string;
  payload: ToolActionPayload;
}) {
  const tool = TOOL_REGISTRY[payload.tool] ?? TOOL_FALLBACK;
  const dotClass =
    payload.status === "success"
      ? "bg-emerald-500"
      : payload.status === "error"
        ? "bg-red-500"
        : "bg-muted-foreground/40";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span
        className={cn("size-1.5 rounded-full inline-block", dotClass)}
        aria-hidden
      />
      <span className="font-medium text-foreground">{actor}</span>
      <span>·</span>
      <span>{payload.label}</span>
      {payload.url ? (
        <a
          href={payload.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Open in {tool.label}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
    </span>
  );
}

function StatusChip({
  label,
  palette,
}: {
  label: string;
  palette?: ReadonlyMap<string, string>;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
        statusClassWithPalette(label, palette),
      )}
    >
      {label}
    </span>
  );
}

/**
 * Renders a `content_changed` event. The actor (user vs algorithm vs tool
 * vs sync vs import vs api) drives the leading phrasing. The target.kind
 * picks the body: production_item_field / draft_field get a compact
 * before → after diff; media variants render a thumbnail-bearing line.
 */
function ContentChangedBody({
  actorName,
  payload,
}: {
  actorName: string;
  payload: ContentChangedPayload;
}) {
  const { source, target } = payload;
  const subject =
    source.kind === "user" ? (
      <span className="font-medium text-foreground">{actorName}</span>
    ) : (
      (() => {
        const badge = badgeForSource(source);
        if (!badge) return <span className="font-medium text-foreground">{actorName}</span>;
        const { Icon, label, accent } = badge;
        return (
          <span className={cn("inline-flex items-center gap-1 font-medium", accent)}>
            <Icon className="size-3.5" />
            {label}
          </span>
        );
      })()
    );

  if (target.kind === "production_item_field") {
    return (
      <EditValueDiff
        header={
          <>
            {subject} changed{" "}
            <span className="font-medium text-foreground">
              {fieldLabel(target.field)}
            </span>
          </>
        }
        from={payload.from ?? null}
        to={payload.to ?? null}
        truncated={!!payload.truncated}
      />
    );
  }
  if (target.kind === "draft_field") {
    return (
      <EditValueDiff
        header={
          <>
            {subject} edited the{" "}
            <span className="font-medium text-foreground">
              {fieldLabel(target.field)}
            </span>{" "}
            <span className="text-xs text-muted-foreground">
              (caption v{target.version})
            </span>
          </>
        }
        from={payload.from ?? null}
        to={payload.to ?? null}
        truncated={!!payload.truncated}
      />
    );
  }
  if (target.kind === "media_added" || target.kind === "media_removed") {
    const verb = target.kind === "media_added" ? "added" : "removed";
    const Icon = target.kind === "media_added" ? ImageIcon : TrashIcon;
    return (
      <div className="flex items-center gap-2">
        <span>
          {subject} {verb} slide {target.index + 1}{" "}
          <span className="text-xs text-muted-foreground">
            ({target.mediaKind})
          </span>
        </span>
        <MediaThumb
          s3Key={target.s3Key}
          posterS3Key={target.posterS3Key}
          kind={target.mediaKind}
          fallbackIcon={Icon}
        />
      </div>
    );
  }
  if (target.kind === "media_reordered") {
    return (
      <span>
        {subject} moved slide {target.fromIndex + 1} to position{" "}
        {target.toIndex + 1}{" "}
        <MoveHorizontalIcon className="inline size-3.5 align-text-bottom" />
      </span>
    );
  }
  return null;
}

/** Compact diff renderer used by ContentChangedBody. Short, single-line
 *  values render inline next to the header ("changed Published date · (empty)
 *  → 2026-05-14"). Long / multi-line / write-truncated values collapse to
 *  the header + a chevron; clicking the chevron reveals the full stacked
 *  from/to block. */
const INLINE_VALUE_MAX = 60;

function EditValueDiff({
  header,
  from,
  to,
  truncated,
}: {
  header: React.ReactNode;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // Hide diff entirely when either side is an unreadable UUID. The verb
  // ("X changed Account") tells the editor what happened; the UUIDs
  // would just be noise. The full payload is still recoverable from
  // the events table for support / audit.
  if (isUuidValue(from) || isUuidValue(to)) {
    return <span>{header}</span>;
  }

  // Smarter value rendering: shorten URLs to host+short-path, format
  // ISO dates into "May 15, 2026". Keeps the inline-eligibility check
  // operating on the already-shortened values.
  const renderValue = (v: string | number | boolean | null): string => {
    const raw = formatValue(v);
    if (isUrlish(raw)) return truncateUrl(raw);
    if (isIsoDate(raw)) return formatIsoDate(raw);
    return raw;
  };
  const f = renderValue(from);
  const t = renderValue(to);
  const hasNewline = f.includes("\n") || t.includes("\n");
  const inlineEligible =
    !truncated &&
    !hasNewline &&
    f.length <= INLINE_VALUE_MAX &&
    t.length <= INLINE_VALUE_MAX;

  if (inlineEligible) {
    return (
      <span>
        {header}
        <span className="text-muted-foreground/60"> · </span>
        <span className="font-mono text-xs text-muted-foreground/80">{f}</span>
        <span className="font-mono text-xs text-muted-foreground/60"> → </span>
        <span className="font-mono text-xs text-foreground">{t}</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-baseline gap-1 text-left hover:text-foreground"
      >
        <span>{header}</span>
        <ChevronRight
          className={cn(
            "size-3 self-center text-muted-foreground/60 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 text-xs font-mono">
          <div className="text-muted-foreground/80">
            <span className="inline-block w-12 text-muted-foreground/60">
              from
            </span>
            <span className="whitespace-pre-wrap break-words">{f}</span>
          </div>
          <div className="text-foreground">
            <span className="inline-block w-12 text-muted-foreground/60">
              to
            </span>
            <span className="whitespace-pre-wrap break-words">{t}</span>
          </div>
          {truncated && (
            <p className="ml-12 text-[10px] font-sans text-muted-foreground/70">
              Truncated at write time; longer values are recoverable from the
              version chain.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function formatValue(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.length === 0 ? "(empty)" : v;
  return String(v);
}

/** Tiny thumbnail for media_added / media_removed events. Falls back to
 *  a generic icon when no s3Key is recoverable. Presigned URLs are
 *  fetched lazily via /api/files (server-side auth proxy) so deleted-row
 *  snapshots still render after the underlying row is gone. */
function MediaThumb({
  s3Key,
  posterS3Key,
  kind,
  fallbackIcon: FallbackIcon,
}: {
  s3Key: string | null;
  posterS3Key: string | null;
  kind: "image" | "video";
  fallbackIcon: LucideIcon;
}) {
  // Videos without a poster show the fallback icon — `<img src=…mp4>` is
  // a broken-image icon in every browser. Posters are generated later by
  // Descript publish / ffmpeg thumbnail flows; until then the s3Key is an
  // MP4 we can't render as an image. Only images and videos-with-poster
  // get the real thumb.
  const imageKey = kind === "video" ? posterS3Key : (posterS3Key ?? s3Key);
  if (!imageKey) {
    return (
      <span className="relative inline-flex size-8 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
        <FallbackIcon className="size-4" />
        {kind === "video" && (
          <VideoIcon className="absolute right-0 bottom-0 size-3 rounded-tl bg-black/60 p-0.5 text-white" />
        )}
      </span>
    );
  }
  return (
    <span className="relative inline-flex size-8 overflow-hidden rounded border border-border bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/files/${encodeURIComponent(imageKey)}`}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
      />
      {kind === "video" && (
        <VideoIcon className="absolute right-0 bottom-0 size-3 rounded-tl bg-black/60 p-0.5 text-white" />
      )}
    </span>
  );
}
