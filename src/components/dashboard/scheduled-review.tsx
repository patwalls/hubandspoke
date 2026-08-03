"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Calendar, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postTypeLabel } from "@/lib/badge-colors";
import type {
  ScheduledReviewData,
  ScheduledMatchSuggestionView,
  NeedsAttentionItemView,
  WatchingNoDateItemView,
} from "@/lib/services/schedule-reconcile/review";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PostBox({
  heading,
  title,
  hook,
  postType,
  timeLabel,
  time,
  href,
  external,
}: {
  heading: string;
  title: string | null;
  hook: string | null;
  postType: string | null;
  timeLabel: string;
  time: string | null;
  href?: string | null;
  external?: boolean;
}) {
  const body = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      <div className="mt-1 text-sm font-medium text-foreground line-clamp-2">
        {title || hook || "(untitled)"}
      </div>
      {hook && hook !== title ? (
        <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
          {hook}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">
          {postTypeLabel(postType)}
        </span>
        <span>
          {timeLabel}: {fmt(time)}
        </span>
      </div>
    </>
  );
  const className =
    "flex-1 rounded-md border border-border bg-card p-3 transition-colors";
  if (href) {
    return external ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:border-foreground/30`}
      >
        {body}
      </a>
    ) : (
      <Link href={href} className={`${className} hover:border-foreground/30`}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

function SuggestionCard({
  brand,
  s,
  onResolved,
}: {
  brand: string;
  s: ScheduledMatchSuggestionView;
  onResolved: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);

  async function act(action: "confirm" | "reject") {
    setBusy(action);
    try {
      const res = await fetch(`/api/scheduled-matches/${s.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't update match");
        return;
      }
      toast.success(action === "confirm" ? "Tied & published" : "Match rejected");
      onResolved(s.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
          {s.score}% match
        </span>
        {s.reason ? (
          <span className="text-xs text-muted-foreground line-clamp-1">
            {s.reason}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <PostBox
          heading="Scheduled (your plan)"
          title={s.scheduled.title}
          hook={s.scheduled.hook}
          postType={s.scheduled.postType}
          timeLabel={s.scheduled.expectedPublishAt ? "expected" : "scheduled"}
          time={s.scheduled.expectedPublishAt ?? s.scheduled.scheduledAt}
          href={`/${brand}/content/${s.scheduled.id}`}
        />
        <ArrowRight className="mx-auto size-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />
        <PostBox
          heading="Live post (detected)"
          title={s.candidate.title}
          hook={s.candidate.hook}
          postType={s.candidate.postType}
          timeLabel="published"
          time={s.candidate.publishedAt}
          href={s.candidate.publishedLink}
          external
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => act("reject")}
        >
          {busy === "reject" ? "Rejecting…" : "Not a match"}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => act("confirm")}
        >
          {busy === "confirm" ? "Tying…" : "Confirm & publish"}
        </Button>
      </div>
    </div>
  );
}

export function ScheduledReview({
  brand,
  initialData,
}: {
  brand: string;
  initialData: ScheduledReviewData;
}) {
  const [data, setData] = useState<ScheduledReviewData>(initialData);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/scheduled-matches?brand=${encodeURIComponent(brand)}`,
      );
      if (res.ok) setData(await res.json());
    } catch {
      // best-effort refresh; the optimistic removal already updated the UI
    }
  }, [brand]);

  // Light polling so an auto-merge / new suggestion from the sweep shows up
  // without a manual reload.
  useEffect(() => {
    const t = setInterval(refetch, 30_000);
    return () => clearInterval(t);
  }, [refetch]);

  function onResolved(id: string) {
    setData((d) => ({
      ...d,
      suggestions: d.suggestions.filter((s) => s.id !== id),
    }));
    void refetch();
  }

  const { suggestions, needsAttention, watching } = data;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">
          Suggested matches
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Likely-but-uncertain ties between a Scheduled post and a freshly
          detected live post. Confident matches (≥85%) tie automatically;
          these need your call.
        </p>
        {suggestions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No suggestions to review. Confident matches are tied automatically.
          </div>
        ) : (
          <div className="space-y-3">
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                brand={brand}
                s={s}
                onResolved={onResolved}
              />
            ))}
          </div>
        )}
      </section>

      {watching.length > 0 && (
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-foreground">
            <Eye className="size-4 text-blue-500" />
            Watching for publish
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Scheduled without a publish date. Checked hourly for up to 14 days — will auto-tie when the video goes live.
          </p>
          <div className="space-y-2">
            {watching.map((n: WatchingNoDateItemView) => (
              <Link
                key={n.id}
                href={`/${brand}/content/${n.id}`}
                className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50/50 px-3 py-2 transition-colors hover:border-blue-300 dark:border-blue-900 dark:bg-blue-950/20"
              >
                <Eye className="size-4 shrink-0 text-blue-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {n.title || "(untitled)"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {postTypeLabel(n.postType)} · watching since {fmt(n.scheduledAt)}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">View →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-foreground">
          <AlertTriangle className="size-4 text-amber-500" />
          Needs attention
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Scheduled posts we couldn&apos;t auto-detect going live within their
          window. Check whether they posted (and publish manually) or were
          cancelled.
        </p>
        {needsAttention.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing stuck. 🎉
          </div>
        ) : (
          <div className="space-y-2">
            {needsAttention.map((n: NeedsAttentionItemView) => (
              <Link
                key={n.id}
                href={`/${brand}/content/${n.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-foreground/30"
              >
                <Calendar className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {n.title || "(untitled)"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {postTypeLabel(n.postType)} · scheduled{" "}
                    {fmt(n.scheduledAt)}
                    {n.expectedPublishAt
                      ? ` · expected ${fmt(n.expectedPublishAt)}`
                      : ""}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Review →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
