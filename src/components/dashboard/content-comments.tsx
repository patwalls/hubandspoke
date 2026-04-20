"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface CommentUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

interface Comment {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  user: CommentUser | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  isMine: boolean;
}

interface ContentCommentsProps {
  contentId: string;
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

function displayName(comment: Comment): string {
  if (comment.user) {
    if (comment.user.name && comment.user.name.trim()) return comment.user.name;
    return comment.user.email.split("@")[0] ?? comment.user.email;
  }
  if (comment.authorName && comment.authorName.trim()) return comment.authorName;
  return "Deleted user";
}

function initials(comment: Comment): string {
  const name = displayName(comment);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name[0] ?? "?").toUpperCase();
}

const URL_RE = /(https?:\/\/[^\s)]+)/g;

function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  text.replace(URL_RE, (url, _g1, offset: number) => {
    if (offset > last) parts.push(text.slice(last, offset));
    parts.push(
      <a
        key={`l-${i++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline hover:text-blue-700"
      >
        {url}
      </a>,
    );
    last = offset + url.length;
    return url;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function ContentComments({ contentId }: ContentCommentsProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
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
          `/api/production-items/${contentId}/comments`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { comments: Comment[] };
        if (!cancelled) setComments(data.comments);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load comments");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentId]);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || posting) return;
    const tempId = `temp-${++tempCounter.current}`;
    const optimistic: Comment = {
      id: tempId,
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      user: null,
      authorName: null,
      authorAvatarUrl: null,
      isMine: true,
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft("");
    setPosting(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { comment: Comment };
      setComments((prev) =>
        prev.map((c) => (c.id === tempId ? data.comment : c)),
      );
    } catch (e) {
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      setDraft(body);
      setError(e instanceof Error ? e.message : "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }, [draft, posting, contentId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const startEdit = (c: Comment) => {
    setEditingId(c.id);
    setEditDraft(c.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const body = editDraft.trim();
    if (!body || savingEdit) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/comments/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { comment: Comment };
      setComments((prev) =>
        prev.map((c) => (c.id === editingId ? data.comment : c)),
      );
      cancelEdit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update comment");
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this comment?")) return;
    const prev = comments;
    setComments((cs) => cs.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setComments(prev);
      setError(e instanceof Error ? e.message : "Failed to delete comment");
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Comments</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Discuss this post with the team as it moves through review.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No comments yet. Start the discussion.
          </p>
        ) : (
          comments.map((c) => {
            const avatarUrl = c.user?.avatarUrl ?? c.authorAvatarUrl;
            return (
            <div key={c.id} className="group flex gap-3">
              {avatarUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={avatarUrl}
                  alt=""
                  className="size-8 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="size-8 rounded-full bg-accent text-muted-foreground text-xs font-medium inline-flex items-center justify-center shrink-0">
                  {initials(c)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">
                    {displayName(c)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(c.createdAt)}
                  </span>
                  {c.editedAt && (
                    <span className="text-xs text-muted-foreground italic">
                      (edited)
                    </span>
                  )}
                  {c.isMine && editingId !== c.id && (
                    <span className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEdit(c)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(c.id)}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>
                {editingId === c.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={saveEdit}
                        disabled={savingEdit || !editDraft.trim()}
                      >
                        {savingEdit ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={cancelEdit}
                        disabled={savingEdit}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">
                    {linkify(c.body)}
                  </div>
                )}
              </div>
            </div>
            );
          })
        )}
      </div>

      <div className="pt-2 border-t border-border space-y-2">
        <Textarea
          placeholder="Write a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          className="text-sm"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            <kbd className="font-mono">⌘</kbd>/<kbd className="font-mono">Ctrl</kbd> +{" "}
            <kbd className="font-mono">Enter</kbd> to post
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={posting || !draft.trim()}
            size="sm"
          >
            {posting ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
