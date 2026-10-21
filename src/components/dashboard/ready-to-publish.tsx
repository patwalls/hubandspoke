"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Download, ExternalLink, Radar } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { postTypeLabel } from "@/lib/badge-colors";
import { validatePublishedLinkPlatform } from "@/lib/published-link-validation";
import { trackUsage } from "@/lib/usage/track";
import { READY_CHANGED_EVENT } from "@/lib/publish/events";
import { groupByPillar } from "@/lib/publish/group";
import type { ReadyToPublishItem } from "@/lib/publish/ready";

// The Publish screen: every Ready To Publish post in the brand, one row each,
// with the link box right on the row. Post it on the platform, paste the live
// link, press Enter — the row turns Published and focus drops to the next one.
// Same write path as the content page's Publish dialog
// (POST /api/production-items/[id]/publish), so status, date and the
// downstream metrics fetch behave identically.
//
// Rows are grouped by pillar so one pillar's cross-posts go out together, and
// each row carries its post kit (copy caption, download media). When the
// hourly publish-live-sweep thinks a post already went live, the row shows
// that post with a one-click "That's it" (confirms the suggestion through
// POST /api/scheduled-matches/[id], same as the Scheduled tab).

function since(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReadyToPublish({
  brand,
  items,
}: {
  brand: string;
  items: ReadyToPublishItem[];
}) {
  const [published, setPublished] = useState<Record<string, string>>({});
  // Mirror of `published` so two rows finishing back to back both land.
  const publishedRef = useRef<Record<string, string>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const left = items.filter((i) => !published[i.id]).length;
  const groups = groupByPillar(items);
  // Focus walks rows in the order they're shown (group by group).
  const order = groups.flatMap((g) => g.items.map((i) => i.id));

  function focusNextOpen(fromId: string, done: Record<string, string>) {
    for (let j = order.indexOf(fromId) + 1; j < order.length; j++) {
      if (!done[order[j]]) {
        inputs.current[order[j]]?.focus();
        return;
      }
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing is waiting to be published. Posts land here when they move to
        Ready To Publish.
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        {left === 0
          ? "All done — every post here has its live link."
          : `${left} ready to publish. Post it, paste the live link, press Enter.`}
      </p>
      <div className="space-y-6">
        {groups.map((group) => {
          const groupLeft = group.items.filter((i) => !published[i.id]).length;
          return (
            <section key={group.key} data-testid="publish-group">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {group.pillarId ? (
                    <Link href={`/${brand}/content/${group.pillarId}`} className="hover:underline">
                      {group.title}
                    </Link>
                  ) : (
                    group.title
                  )}
                </h2>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {groupLeft === 0 ? "all posted" : `${groupLeft} of ${group.items.length} left`}
                </span>
              </div>
              <div className="space-y-2">
                {group.items.map((item) => (
                  <PublishRow
                    key={item.id}
                    brand={brand}
                    item={item}
                    publishedLink={published[item.id] ?? null}
                    inputRef={(el) => {
                      inputs.current[item.id] = el;
                    }}
                    autoFocus={item.id === order[0]}
                    onPublished={(link) => {
                      const next = { ...publishedRef.current, [item.id]: link };
                      publishedRef.current = next;
                      setPublished(next);
                      window.dispatchEvent(new Event(READY_CHANGED_EVENT));
                      focusNextOpen(item.id, next);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PublishRow({
  brand,
  item,
  publishedLink,
  inputRef,
  autoFocus,
  onPublished,
}: {
  brand: string;
  item: ReadyToPublishItem;
  publishedLink: string | null;
  inputRef: (el: HTMLInputElement | null) => void;
  autoFocus: boolean;
  onPublished: (link: string) => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveMatch, setLiveMatch] = useState(item.liveMatch);
  const [copied, setCopied] = useState(false);
  // Same guard as the content page: a link from another platform than the
  // post (an Instagram link on a TikTok row) is caught before it's saved.
  const mismatch = validatePublishedLinkPlatform(link.trim(), item.postType);

  async function publish() {
    const url = link.trim();
    if (!url) return;
    if (mismatch) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/production-items/${item.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "publish", link: url }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't mark as published");
        return;
      }
      trackUsage("publish:link-pasted", brand);
      onPublished(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function resolveLiveMatch(action: "confirm" | "reject") {
    if (!liveMatch) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scheduled-matches/${liveMatch.suggestionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't save that");
        // A stale suggestion (already resolved / the live post got merged
        // elsewhere) can't be used — drop it so the link box is the way on.
        if (res.status === 404 || res.status === 409 || res.status === 422) {
          setLiveMatch(null);
        }
        return;
      }
      if (action === "reject") {
        trackUsage("publish:live-rejected", brand);
        setLiveMatch(null);
        return;
      }
      trackUsage("publish:live-confirmed", brand);
      onPublished(liveMatch.link ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function copyCaption() {
    if (!item.caption) return;
    try {
      await navigator.clipboard.writeText(item.caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      trackUsage("publish:caption-copied", brand);
    } catch {
      toast.error("Couldn't copy — open the post to copy the caption");
    }
  }

  const heading = item.title || item.hook || "(untitled)";

  return (
    <div
      data-testid="publish-row"
      className={`rounded-md border px-3 py-2 ${
        publishedLink ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-card"
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Link
          href={`/${brand}/content/${item.id}`}
          className="min-w-0 flex-1 hover:underline"
        >
          <div className="truncate text-sm font-medium text-foreground">{heading}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">
              {postTypeLabel(item.postType)}
            </span>
            {item.accountHandle ? <span>@{item.accountHandle}</span> : null}
            {item.sourceType === "cross_post" ? <span>cross-post</span> : null}
            {item.readySince ? <span>ready since {since(item.readySince)}</span> : null}
          </div>
        </Link>
        {publishedLink ? (
          <a
            href={publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
          >
            <Check className="size-3.5" />
            Published
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <Input
            ref={inputRef}
            autoFocus={autoFocus}
            aria-label={`Live link for ${heading}`}
            placeholder="Paste the live link, then Enter"
            value={link}
            disabled={busy}
            onChange={(e) => {
              setLink(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void publish();
              }
            }}
            className="h-8 text-xs sm:w-80"
          />
        )}
      </div>
      {mismatch && !publishedLink ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3" />
          {mismatch}
        </div>
      ) : null}
      {!publishedLink && (item.caption || item.media.length > 0) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {item.caption ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => void copyCaption()}
              title={item.caption}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy caption"}
            </Button>
          ) : null}
          {item.media.map((m, i) => (
            <a
              key={m.url}
              href={m.url}
              download={m.filename}
              onClick={() => trackUsage("publish:media-downloaded", brand)}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-6 gap-1 px-2 text-[11px]",
              )}
            >
              <Download className="size-3" />
              {item.media.length > 1 ? `Media ${i + 1}` : "Download media"}
            </a>
          ))}
        </div>
      ) : null}
      {liveMatch && !publishedLink ? (
        <div
          data-testid="publish-live-match"
          className="mt-2 flex flex-col gap-2 rounded border border-sky-500/30 bg-sky-500/5 px-2.5 py-2 sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5 font-medium text-sky-700 dark:text-sky-300">
              <Radar className="size-3" />
              Looks like this is already live
              {liveMatch.publishedAt ? ` · ${since(liveMatch.publishedAt)}` : ""}
              {liveMatch.link ? (
                <a
                  href={liveMatch.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 hover:underline"
                >
                  open <ExternalLink className="size-2.5" />
                </a>
              ) : null}
            </div>
            {liveMatch.excerpt ? (
              <div className="mt-0.5 truncate">{liveMatch.excerpt}</div>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void resolveLiveMatch("confirm")}
            >
              That&apos;s it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void resolveLiveMatch("reject")}
            >
              Not it
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
