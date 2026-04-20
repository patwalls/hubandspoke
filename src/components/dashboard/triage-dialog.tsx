"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserChip } from "./user-chip";
import { renderInstructions } from "@/lib/utils/markdown";
import type { ProductionItem } from "@/types";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface PillarRef {
  id: string;
  title: string | null;
  format: string | null;
}

interface RepostedFromRef {
  id: string;
  title: string | null;
  publishedDate: string | null;
  publishedLink: string | null;
  platform: string[] | null;
  views: number | null;
  evergreenReasoning: string | null;
}

interface ItemDetail {
  item: ProductionItem & { notionId?: string | null };
  pillar: PillarRef | null;
  formats: { id: string; name: string; instructions: string | null }[];
  repostedFrom: RepostedFromRef | null;
}

interface TriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
}

type RepostActionMode = "idle" | "form";

export function TriageDialog({
  open,
  onOpenChange,
  item,
  brand,
  users,
  onDone,
}: TriageDialogProps) {
  const isRepost = item.sourceType === "repost";
  const isCrossPost = item.sourceType === "cross_post";
  const isSourced = isRepost || isCrossPost;
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<RepostActionMode>("idle");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setSummary(null);
    setSummaryLoading(true);
    setSummaryError(null);
    setActionError(null);
    setMode("idle");

    (async () => {
      try {
        const res = await fetch(`/api/production-items/${item.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ItemDetail;
        if (!cancelled) setDetail(json);
      } catch (err) {
        console.error("Triage detail fetch failed:", err);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    // Reposts/cross-posts inherit context from the source — skip the LLM
    // summary to save spend and latency. Originals still get it.
    if (!isSourced) {
      (async () => {
        try {
          const res = await fetch(`/api/production-items/${item.id}/summary`);
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const json = (await res.json()) as { summary: string | null };
          if (!cancelled) setSummary(json.summary);
        } catch (err) {
          if (!cancelled)
            setSummaryError(
              err instanceof Error ? err.message : "Summary failed"
            );
        } finally {
          if (!cancelled) setSummaryLoading(false);
        }
      })();
    } else {
      setSummaryLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [open, item.id, isSourced]);

  async function updateStatus(
    nextStatus: "Assigned" | "Killed" | "Published",
    extra?: Record<string, unknown>
  ) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: nextStatus, ...extra }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : `Failed to mark ${nextStatus}`
      );
    } finally {
      setSaving(false);
    }
  }

  function assignTo(userId: string) {
    return updateStatus("Assigned", { editorUserId: userId });
  }

  function killIt() {
    if (!confirm(`Kill "${item.title || "(Untitled)"}"?`)) return;
    return updateStatus("Killed");
  }

  const pillar = detail?.pillar;
  const repostedFrom = detail?.repostedFrom ?? null;
  const formatInstructions =
    detail && item.format
      ? detail.formats.find((f) => f.name === item.format)?.instructions ?? null
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto gap-5">
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            {isRepost && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-900 border border-amber-200"
                title="Reposting an existing piece of content"
              >
                Repost
              </span>
            )}
            {isCrossPost && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-900 border border-indigo-200"
                title="Same content syndicated to a different platform"
              >
                Cross-post
              </span>
            )}
            {(item.platform || []).map((p) => (
              <span
                key={p}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
              >
                {p}
              </span>
            ))}
            {item.format && !isSourced && (
              <span className="text-xs text-muted-foreground">
                · {item.format}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold pr-8">
            {item.title || "(Untitled)"}
          </DialogTitle>
        </DialogHeader>

        {isSourced ? (
          <SourcedBody
            kind={isCrossPost ? "cross_post" : "repost"}
            loading={detailLoading}
            repostedFrom={repostedFrom}
            item={item}
            brand={brand}
            saving={saving}
            mode={mode}
            setMode={setMode}
            actionError={actionError}
            onMarkPublished={(fields) => updateStatus("Published", fields)}
            onKill={killIt}
          />
        ) : (
          <OriginalBody
            brand={brand}
            detailLoading={detailLoading}
            pillar={pillar ?? null}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            formatInstructions={formatInstructions}
            users={users}
            saving={saving}
            actionError={actionError}
            onAssign={assignTo}
            onKill={killIt}
            itemId={item.id}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Sourced (repost + cross-post) body ──────────────────────────────────
function SourcedBody({
  kind,
  loading,
  repostedFrom,
  item,
  brand,
  saving,
  mode,
  setMode,
  actionError,
  onMarkPublished,
  onKill,
}: {
  kind: "repost" | "cross_post";
  loading: boolean;
  repostedFrom: RepostedFromRef | null;
  item: ProductionItem;
  brand: string;
  saving: boolean;
  mode: RepostActionMode;
  setMode: (m: RepostActionMode) => void;
  actionError: string | null;
  onMarkPublished: (fields: {
    publishedLink: string;
    publishedDate: string;
    views?: number | null;
    likes?: number | null;
  }) => Promise<unknown>;
  onKill: () => void;
}) {
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading source post…</p>
    );
  }

  const isCrossPost = kind === "cross_post";
  const sourceChannel = repostedFrom?.platform?.[0] ?? "";
  const targetChannel = (item.platform ?? [])[0] ?? "";
  const isTwitter =
    sourceChannel === "Twitter" ||
    sourceChannel === "Twitter (Pat Walls)" ||
    (repostedFrom?.publishedLink &&
      /^https:\/\/(?:www\.)?(?:twitter|x)\.com\//.test(
        repostedFrom.publishedLink
      ));

  const reasoningLabel = isCrossPost ? "Why cross-post this" : "Why repost this";
  const sourceLabel = isCrossPost ? "Source post" : "Original post";
  const panelStyles = isCrossPost
    ? "bg-indigo-50 border-indigo-200"
    : "bg-amber-50 border-amber-200";

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
      {/* LEFT: context + actions */}
      <div className="md:col-span-5 space-y-4">
        {isCrossPost && sourceChannel && targetChannel && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {reasoningLabel}
            </h3>
            <p className={`text-sm text-foreground leading-relaxed ${panelStyles} border rounded-md p-3`}>
              Source ran on <span className="font-medium">{sourceChannel}</span>
              {repostedFrom?.views != null && (
                <> and hit {formatCompact(repostedFrom.views)} views</>
              )}
              . Re-post on <span className="font-medium">{targetChannel}</span>{" "}
              with light tweaks for the platform.
            </p>
          </section>
        )}
        {!isCrossPost && repostedFrom?.evergreenReasoning && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {reasoningLabel}
            </h3>
            <p className={`text-sm text-foreground leading-relaxed ${panelStyles} border rounded-md p-3`}>
              {repostedFrom.evergreenReasoning}
            </p>
          </section>
        )}

        <section className="space-y-2">
          {mode === "idle" ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setMode("form")}
                disabled={saving}
                className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                I posted this ✓
              </button>
              {repostedFrom?.publishedLink && (
                <a
                  href={repostedFrom.publishedLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
                >
                  Open source
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
            </div>
          ) : (
            <PostedForm
              saving={saving}
              onSubmit={onMarkPublished}
              onCancel={() => setMode("idle")}
              defaultChannel={targetChannel || sourceChannel}
            />
          )}
          {actionError && (
            <p className="text-[11px] text-red-600">{actionError}</p>
          )}
        </section>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            onClick={onKill}
            disabled={saving}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Kill this idea
          </button>
          <Link
            href={`/${brand}/content/${item.id}`}
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Open full page
            <ExternalLinkIcon className="size-3" />
          </Link>
        </div>
      </div>

      {/* RIGHT: source post */}
      <div className="md:col-span-7 space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {sourceLabel}
          {repostedFrom?.publishedDate && (
            <span className="ml-2 font-normal normal-case tracking-normal text-xs text-muted-foreground">
              from {new Date(repostedFrom.publishedDate).toLocaleDateString(
                "en-US",
                { year: "numeric", month: "short", day: "numeric" }
              )}
              {repostedFrom.views != null && (
                <> · {formatCompact(repostedFrom.views)} views</>
              )}
            </span>
          )}
        </h3>

        {repostedFrom?.publishedLink && isTwitter ? (
          <TweetEmbed url={repostedFrom.publishedLink} />
        ) : repostedFrom?.publishedLink ? (
          <a
            href={repostedFrom.publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-accent/30 border border-border rounded-md p-3 hover:bg-accent transition-colors"
          >
            <div className="text-sm font-medium text-foreground">
              {repostedFrom.title || "(Untitled)"}
            </div>
            <div className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
              {repostedFrom.publishedLink}
              <ExternalLinkIcon className="size-3" />
            </div>
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            No published link on the source.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Posted-confirmation form ────────────────────────────────────────────
function PostedForm({
  saving,
  onSubmit,
  onCancel,
  defaultChannel,
}: {
  saving: boolean;
  onSubmit: (fields: {
    publishedLink: string;
    publishedDate: string;
    views?: number | null;
    likes?: number | null;
  }) => Promise<unknown>;
  onCancel: () => void;
  defaultChannel: string;
}) {
  const [link, setLink] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [views, setViews] = useState("");
  const [likes, setLikes] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const linkPlaceholder =
    defaultChannel.startsWith("Twitter") || defaultChannel === "Twitter"
      ? "https://x.com/your-handle/status/…"
      : defaultChannel === "Instagram Reel"
      ? "https://instagram.com/reel/…"
      : "https://…";

  function validateLink(value: string): string | null {
    if (!value.trim()) return "Required";
    if (!/^https:\/\//.test(value.trim())) return "Must start with https://";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateLink(link);
    setLinkError(err);
    if (err) return;
    await onSubmit({
      publishedLink: link.trim(),
      publishedDate: date,
      views: views === "" ? null : Number(views),
      likes: likes === "" ? null : Number(likes),
    });
  }

  const canSubmit = !saving && !!link.trim() && !!date;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Post details
      </h3>

      <div className="space-y-1">
        <label
          htmlFor="posted-link"
          className="block text-xs font-medium text-foreground"
        >
          Published link <span className="text-red-600">*</span>
        </label>
        <input
          id="posted-link"
          type="url"
          required
          autoFocus
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            if (linkError) setLinkError(validateLink(e.target.value));
          }}
          placeholder={linkPlaceholder}
          className="w-full rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {linkError && <p className="text-[11px] text-red-600">{linkError}</p>}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="posted-date"
          className="block text-xs font-medium text-foreground"
        >
          Published date <span className="text-red-600">*</span>
        </label>
        <input
          id="posted-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label
            htmlFor="posted-views"
            className="block text-xs font-medium text-foreground"
          >
            Views
          </label>
          <input
            id="posted-views"
            type="number"
            inputMode="numeric"
            min={0}
            value={views}
            onChange={(e) => setViews(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="posted-likes"
            className="block text-xs font-medium text-foreground"
          >
            Likes
          </label>
          <input
            id="posted-likes"
            type="number"
            inputMode="numeric"
            min={0}
            value={likes}
            onChange={(e) => setLikes(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Mark posted"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Original (non-repost) body ──────────────────────────────────────────
function OriginalBody({
  brand,
  detailLoading,
  pillar,
  summary,
  summaryLoading,
  summaryError,
  formatInstructions,
  users,
  saving,
  actionError,
  onAssign,
  onKill,
  itemId,
}: {
  brand: string;
  detailLoading: boolean;
  pillar: PillarRef | null;
  summary: string | null;
  summaryLoading: boolean;
  summaryError: string | null;
  formatInstructions: string | null;
  users: AssignableUser[];
  saving: boolean;
  actionError: string | null;
  onAssign: (userId: string) => Promise<unknown>;
  onKill: () => void;
  itemId: string;
}) {
  return (
    <>
      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pillar content
        </h3>
        {detailLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pillar ? (
          <Link
            href={`/${brand}/content/${pillar.id}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary hover:underline"
          >
            {pillar.title || "(Untitled)"}
            {pillar.format && (
              <span className="text-xs text-muted-foreground">
                · {pillar.format}
              </span>
            )}
            <ExternalLinkIcon className="size-3 text-muted-foreground" />
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">No pillar linked.</p>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Summary
        </h3>
        {summaryLoading ? (
          <p className="text-sm text-muted-foreground">Generating…</p>
        ) : summaryError ? (
          <p className="text-sm text-red-600">
            Couldn&apos;t generate a summary.
          </p>
        ) : summary ? (
          <p className="text-sm text-foreground leading-relaxed bg-accent/30 rounded-md p-3">
            {summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">(empty)</p>
        )}
      </section>

      {formatInstructions && (
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Format skill
          </h3>
          <div className="whitespace-pre-wrap break-words text-xs text-foreground bg-accent/30 rounded-md p-3 max-h-60 overflow-auto leading-relaxed">
            {renderInstructions(formatInstructions)}
          </div>
        </section>
      )}

      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Assign editor
        </h3>
        <div className="max-h-56 overflow-y-auto grid grid-cols-2 lg:grid-cols-3 gap-1">
          {users.length === 0 ? (
            <div className="text-xs text-muted-foreground col-span-full">
              No assignable users found.
            </div>
          ) : (
            users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onAssign(u.id)}
                disabled={saving}
                className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                <UserChip user={u} size="xs" />
              </button>
            ))
          )}
        </div>

        {actionError && (
          <p className="text-[11px] text-red-600">{actionError}</p>
        )}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onKill}
            disabled={saving}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Kill this idea
          </button>
          <Link
            href={`/${brand}/content/${itemId}`}
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Open full page
            <ExternalLinkIcon className="size-3" />
          </Link>
        </div>
      </section>
    </>
  );
}

// ─── Tweet embed ─────────────────────────────────────────────────────────
declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (el?: HTMLElement) => void;
      };
    };
  }
}

function TweetEmbed({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function loadAndRender() {
      if (cancelled || !ref.current) return;
      if (!window.twttr?.widgets) return;
      window.twttr.widgets.load(ref.current);
      setRendered(true);
    }

    if (window.twttr?.widgets) {
      loadAndRender();
      return () => {
        cancelled = true;
      };
    }

    // First embed on this page — inject widgets.js once. Subsequent embeds
    // reuse the same window.twttr singleton.
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.twitter.com/widgets.js"]'
    );
    if (existing) {
      existing.addEventListener("load", loadAndRender, { once: true });
    } else {
      const s = document.createElement("script");
      s.src = "https://platform.twitter.com/widgets.js";
      s.async = true;
      s.charset = "utf-8";
      s.addEventListener("load", loadAndRender, { once: true });
      document.body.appendChild(s);
    }

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div
      ref={ref}
      className="bg-accent/20 border border-border rounded-md p-2 min-h-[120px]"
    >
      <blockquote className="twitter-tweet" data-conversation="none">
        <a href={url}>{url}</a>
      </blockquote>
      {!rendered && (
        <p className="text-xs text-muted-foreground px-2 py-1">
          Loading tweet…
        </p>
      )}
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}
