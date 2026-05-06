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
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
          className="inline-flex items-center justify-center rounded bg-black/70 hover:bg-black/85 text-white size-7 backdrop-blur-sm"
          title="Download"
          aria-label="Download image"
        >
          <DownloadIcon className="size-3.5" />
        </a>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center justify-center rounded bg-black/70 hover:bg-black/85 text-white size-7 backdrop-blur-sm"
          title={copied ? "Copied" : "Copy image"}
          aria-label="Copy image to clipboard"
        >
          {copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
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
        className="inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent size-5"
        title="Download"
        aria-label="Download file"
      >
        <DownloadIcon className="size-3" />
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

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Activity</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Comments and status changes as this post moves through review.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {loading && !hasLoaded ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Start the discussion.
          </p>
        ) : (
          items.map((item) =>
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
  return (
    <span>
      <span className="font-medium text-foreground">{actorName}</span> logged{" "}
      {event.eventType}
    </span>
  );
}

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
