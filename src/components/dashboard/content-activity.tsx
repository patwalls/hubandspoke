"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { CommentEditor, isEditorEmpty } from "@/components/dashboard/comment-editor";

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

type EventPayload =
  | { type: "status_change"; from: string | null; to: string | null }
  | { type: "killed"; from: string | null; reason: string | null }
  | { type: "editor_change"; from: string | null; to: string | null };

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
  // Bump to trigger a refetch (e.g. after the parent saves a status change).
  refreshKey?: number;
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

function CommentBody({ body }: { body: string }) {
  const isHtml = body.trimStart().startsWith("<");
  if (isHtml) {
    return (
      <div
        className="tiptap mt-0.5 text-sm text-foreground break-words space-y-2 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: body }}
      />
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

export function ContentActivity({ contentId, refreshKey = 0 }: ContentActivityProps) {
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
              <EventRow key={item.id} event={item} />
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

function EventRow({ event }: { event: EventItem }) {
  const actorName = userDisplayName(event.user, "Someone");
  const avatarUrl = event.user?.avatarUrl ?? null;
  return (
    <div className="flex gap-3 items-center">
      {avatarUrl ? (
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
        <EventBody actorName={actorName} event={event} />{" "}
        <span className="text-xs">· {timeAgo(event.createdAt)}</span>
      </div>
    </div>
  );
}

function EventBody({
  actorName,
  event,
}: {
  actorName: string;
  event: EventItem;
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
            from <StatusChip label={from} />
          </>
        ) : null}{" "}
        to {to ? <StatusChip label={to} /> : <em>none</em>}
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
  return (
    <span>
      <span className="font-medium text-foreground">{actorName}</span> logged{" "}
      {event.eventType}
    </span>
  );
}

function StatusChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-accent/50 px-1.5 py-0.5 text-xs font-medium text-foreground">
      {label}
    </span>
  );
}
