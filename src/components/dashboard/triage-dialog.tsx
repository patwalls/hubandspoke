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

export function TriageDialog({
  open,
  onOpenChange,
  item,
  brand,
  users,
  onDone,
}: TriageDialogProps) {
  const isRepost = item.sourceType === "repost";
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setSummary(null);
    setSummaryLoading(true);
    setSummaryError(null);
    setActionError(null);

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

    // Reposts already have an AI-authored "why" — skip the summary fetch to
    // save LLM spend and latency. Originals still get it.
    if (!isRepost) {
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
  }, [open, item.id, isRepost]);

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

  function markPublished() {
    return updateStatus("Published", {
      publishedDate: new Date().toISOString().slice(0, 10),
    });
  }

  const pillar = detail?.pillar;
  const repostedFrom = detail?.repostedFrom ?? null;
  const formatInstructions =
    detail && item.format
      ? detail.formats.find((f) => f.name === item.format)?.instructions ?? null
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto gap-5">
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
            {(item.platform || []).map((p) => (
              <span
                key={p}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
              >
                {p}
              </span>
            ))}
            {item.format && !isRepost && (
              <span className="text-xs text-muted-foreground">
                · {item.format}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold pr-8">
            {item.title || "(Untitled)"}
          </DialogTitle>
        </DialogHeader>

        {isRepost ? (
          <RepostSection
            loading={detailLoading}
            repostedFrom={repostedFrom}
          />
        ) : (
          <>
            {/* Pillar content */}
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
                <p className="text-sm text-muted-foreground">
                  No pillar linked.
                </p>
              )}
            </section>

            {/* AI summary */}
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
          </>
        )}

        {/* Format instructions */}
        {formatInstructions && !isRepost && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Format skill
            </h3>
            <div className="whitespace-pre-wrap break-words text-xs text-foreground bg-accent/30 rounded-md p-3 max-h-60 overflow-auto leading-relaxed">
              {formatInstructions}
            </div>
          </section>
        )}

        {/* Actions */}
        <section className="space-y-2 border-t border-border pt-4">
          {isRepost ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={markPublished}
                disabled={saving}
                className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? "Saving…" : "I posted this ✓"}
              </button>
              {repostedFrom?.publishedLink && (
                <a
                  href={repostedFrom.publishedLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
                >
                  Open original
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
            </div>
          ) : (
            <>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Assign editor
              </h3>
              <div className="max-h-48 overflow-y-auto grid grid-cols-2 gap-1">
                {users.length === 0 ? (
                  <div className="text-xs text-muted-foreground col-span-2">
                    No assignable users found.
                  </div>
                ) : (
                  users.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => assignTo(u.id)}
                      disabled={saving}
                      className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      <UserChip user={u} size="xs" />
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {actionError && (
            <p className="text-[11px] text-red-600">{actionError}</p>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={killIt}
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
        </section>
      </DialogContent>
    </Dialog>
  );
}

function RepostSection({
  loading,
  repostedFrom,
}: {
  loading: boolean;
  repostedFrom: RepostedFromRef | null;
}) {
  if (loading) {
    return (
      <section className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Loading original post…</p>
      </section>
    );
  }
  if (!repostedFrom) {
    return (
      <section className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          Original post not found. It may have been deleted.
        </p>
      </section>
    );
  }

  const channel = repostedFrom.platform?.[0] ?? "";
  const isTwitter =
    channel === "Twitter" ||
    channel === "Twitter (Pat Walls)" ||
    (repostedFrom.publishedLink &&
      /^https:\/\/(?:www\.)?(?:twitter|x)\.com\//.test(
        repostedFrom.publishedLink
      ));

  return (
    <>
      {/* Why this was recommended */}
      {repostedFrom.evergreenReasoning && (
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Why repost this
          </h3>
          <p className="text-sm text-foreground leading-relaxed bg-amber-50 border border-amber-200 rounded-md p-3">
            {repostedFrom.evergreenReasoning}
          </p>
        </section>
      )}

      {/* Original post */}
      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Original post
          {repostedFrom.publishedDate && (
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

        {repostedFrom.publishedLink && isTwitter ? (
          <TweetEmbed url={repostedFrom.publishedLink} />
        ) : repostedFrom.publishedLink ? (
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
            No published link on the original.
          </p>
        )}
      </section>
    </>
  );
}

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
