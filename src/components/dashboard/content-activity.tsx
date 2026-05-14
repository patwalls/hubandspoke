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
import { CommentEditor, isEditorEmpty } from "@/components/dashboard/comment-editor";
import { statusClassWithPalette } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

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
  // Filter only `content_changed` events whose source.kind is non-user.
  // All other event variants (status_change, item_created, tool_action,
  // killed, repost_created, …) stay visible regardless — they're already
  // editorially meaningful by their existence.
  const hiddenSystemCount = items.filter(
    (item) =>
      item.kind === "event" &&
      item.payload.type === "content_changed" &&
      item.payload.source.kind !== "user",
  ).length;
  const visibleItems = showSystem
    ? items
    : items.filter(
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
          visibleItems.map((item) =>
            item.kind === "comment" ? (
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
            ) : (
              <EventRow key={item.id} event={item} brand={brand} statusPalette={statusPalette} />
            ),
          )
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
      <div className="space-y-1">
        <div>
          {subject} changed{" "}
          <span className="font-medium text-foreground">
            {fieldLabel(target.field)}
          </span>
        </div>
        <EditValueDiff
          from={payload.from ?? null}
          to={payload.to ?? null}
          truncated={!!payload.truncated}
        />
      </div>
    );
  }
  if (target.kind === "draft_field") {
    return (
      <div className="space-y-1">
        <div>
          {subject} edited the{" "}
          <span className="font-medium text-foreground">
            {fieldLabel(target.field)}
          </span>{" "}
          <span className="text-xs text-muted-foreground">
            (caption v{target.version})
          </span>
        </div>
        <EditValueDiff
          from={payload.from ?? null}
          to={payload.to ?? null}
          truncated={!!payload.truncated}
        />
      </div>
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

/** Compact diff renderer used by ContentChangedBody. Two stacked mono rows
 *  for before / after with 120-char clamp. Long values get a "Show full"
 *  expander that pops the un-truncated text in a small popover. */
function EditValueDiff({
  from,
  to,
  truncated,
}: {
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const f = formatValue(from);
  const t = formatValue(to);
  const needsClamp =
    !expanded && (f.length > 120 || t.length > 120 || truncated);
  const renderFrom = needsClamp ? clamp(f, 120) : f;
  const renderTo = needsClamp ? clamp(t, 120) : t;
  return (
    <div className="space-y-0.5 text-xs font-mono">
      <div className="text-muted-foreground/80">
        <span className="inline-block w-12 text-muted-foreground/60">from</span>
        <span className="whitespace-pre-wrap break-words">{renderFrom}</span>
      </div>
      <div className="text-foreground">
        <span className="inline-block w-12 text-muted-foreground/60">to</span>
        <span className="whitespace-pre-wrap break-words">{renderTo}</span>
      </div>
      {(needsClamp || (expanded && truncated)) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-12 mt-0.5 inline-flex items-center gap-1 text-[11px] font-sans text-primary hover:underline"
        >
          {expanded ? "Hide" : "Show full"}
        </button>
      )}
      {truncated && expanded && (
        <p className="ml-12 text-[10px] font-sans text-muted-foreground/70">
          Truncated at write time; longer values are recoverable from the
          version chain.
        </p>
      )}
    </div>
  );
}

function formatValue(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.length === 0 ? "(empty)" : v;
  return String(v);
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
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
  const key = posterS3Key ?? s3Key;
  if (!key) {
    return (
      <span className="inline-flex size-8 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
        <FallbackIcon className="size-4" />
      </span>
    );
  }
  return (
    <span className="relative inline-flex size-8 overflow-hidden rounded border border-border bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/files/${encodeURIComponent(key)}`}
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
