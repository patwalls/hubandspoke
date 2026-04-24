"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  FeedData,
  FeedRecentRow,
} from "@/lib/services/cross-post-feed-data";
import { PlatformIcon } from "@/components/ui/platform-icon";

interface Props {
  brand: string;
  brandLabel: string;
  data: FeedData;
}

// Standalone retrospective for cross-posts. The pending triage list now
// lives inside Queue → Cross-post tab (rows open the TriageDialog). This
// page stays focused on what-happened: recent decisions the scanner logged
// and the accept/kill reasons that are actively training the LLM.
export function CrossPostFeed({ brand, brandLabel, data }: Props) {
  const [showRecent, setShowRecent] = useState(true);
  const [showFeedback, setShowFeedback] = useState(true);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Cross posting</h1>
        <p className="text-sm text-muted-foreground">
          {brandLabel} — pending suggestions live in the{" "}
          <Link
            href={`/${brand}/queue`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Queue
          </Link>
          . This page shows what the scanner has proposed recently and the
          feedback it&apos;s learning from.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowRecent((v) => !v)}
          className="flex items-center justify-between rounded border border-border px-3 py-2 text-left text-sm hover:bg-muted"
        >
          <span>
            <span className="font-medium">Recent decisions</span>
            <span className="ml-2 text-muted-foreground">
              ({data.recent.length} in last 30 days)
            </span>
          </span>
          <span className="text-muted-foreground">
            {showRecent ? "hide" : "show"}
          </span>
        </button>
        {showRecent ? <RecentList rows={data.recent} /> : null}
      </section>

      <section className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowFeedback((v) => !v)}
          className="flex items-center justify-between rounded border border-border px-3 py-2 text-left text-sm hover:bg-muted"
        >
          <span>
            <span className="font-medium">What I&apos;ve learned</span>
            <span className="ml-2 text-muted-foreground">
              (last {data.feedback.accepts.length + data.feedback.kills.length}{" "}
              accepts + kills — fed into every scanner run)
            </span>
          </span>
          <span className="text-muted-foreground">
            {showFeedback ? "hide" : "show"}
          </span>
        </button>
        {showFeedback ? (
          <FeedbackPanel feedback={data.feedback} />
        ) : null}
      </section>
    </div>
  );
}

function RecentList({ rows }: { rows: FeedRecentRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No decisions recorded in the last 30 days.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-xs">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex flex-col gap-1 rounded border border-border bg-card/50 p-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>{new Date(r.proposedAt).toLocaleDateString()}</span>
            <SourceBadge
              platform={r.source.platform}
              handle={r.source.handle}
              postType={r.source.postType}
            />
            <span>→</span>
            <TargetBadge
              platform={r.target.platform}
              handle={r.target.handle}
              postType={r.target.postType}
            />
            <ConfidenceBadge value={r.confidence} />
            <OutcomeBadge
              outcome={r.outcome}
              ideaStatus={r.ideaStatus}
              ideaItemId={r.ideaItemId}
              confidence={r.confidence}
            />
          </div>
          <p className="text-foreground">{r.source.title ?? "(untitled)"}</p>
          {r.reasoning ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Why:</span>{" "}
              {r.reasoning}
            </p>
          ) : null}
          {r.outcomeReason ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">
                Outcome reason:
              </span>{" "}
              {r.outcomeReason}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OutcomeBadge({
  outcome,
  ideaStatus,
  ideaItemId,
  confidence,
}: {
  outcome: string | null;
  ideaStatus: string | null;
  ideaItemId: string | null;
  confidence: number;
}) {
  if (outcome === "accepted") {
    return (
      <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
        accepted
      </span>
    );
  }
  if (outcome === "killed") {
    return (
      <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-500">
        killed
      </span>
    );
  }
  if (ideaStatus === "Idea") {
    return (
      <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
        pending
      </span>
    );
  }
  if (ideaItemId == null && confidence < 70) {
    return (
      <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
        below confidence floor
      </span>
    );
  }
  if (ideaItemId == null) {
    return (
      <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
        queue cap reached
      </span>
    );
  }
  return (
    <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
      {ideaStatus ?? "—"}
    </span>
  );
}

function FeedbackPanel({ feedback }: { feedback: FeedData["feedback"] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FeedbackColumn
        title="Accepted"
        tone="good"
        entries={feedback.accepts}
        empty="No accepts yet — accept a cross-post in the Queue to start teaching the scanner what to favor."
      />
      <FeedbackColumn
        title="Killed"
        tone="bad"
        entries={feedback.kills}
        empty="No kills yet — kill a cross-post in the Queue with a reason to steer the scanner away from similar pairs."
      />
    </div>
  );
}

function FeedbackColumn({
  title,
  tone,
  entries,
  empty,
}: {
  title: string;
  tone: "good" | "bad";
  entries: FeedData["feedback"]["accepts"];
  empty: string;
}) {
  const accent =
    tone === "good" ? "border-emerald-500/30" : "border-red-500/30";
  return (
    <div className={`flex flex-col gap-2 rounded border ${accent} p-3`}>
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-xs">
          {entries.map((e, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <p className="text-foreground">{e.reason}</p>
              <p className="text-muted-foreground">
                {new Date(e.at).toLocaleDateString()}
                {e.target ? ` · ${e.target}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceBadge({
  platform,
  handle,
  postType,
}: {
  platform: string | null;
  handle: string | null;
  postType: string | null;
}) {
  if (!platform || !handle) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
        source
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
      <PlatformIcon platform={platform} className="h-3 w-3" />
      <span>
        @{handle}
        {postType ? ` · ${prettyPostType(postType)}` : ""}
      </span>
    </span>
  );
}

function TargetBadge({
  platform,
  handle,
  postType,
}: {
  platform: string | null;
  handle: string | null;
  postType: string | null;
}) {
  if (!platform || !handle) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
        target
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
      <PlatformIcon platform={platform} className="h-3 w-3" />
      <span>
        @{handle}
        {postType ? ` · ${prettyPostType(postType)}` : ""}
      </span>
    </span>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const color =
    value >= 85
      ? "bg-emerald-500/15 text-emerald-500"
      : value >= 70
        ? "bg-amber-500/15 text-amber-500"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${color}`}>
      {value}% confidence
    </span>
  );
}

function prettyPostType(pt: string): string {
  return pt
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
