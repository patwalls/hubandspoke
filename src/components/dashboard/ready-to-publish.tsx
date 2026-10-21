"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { postTypeLabel } from "@/lib/badge-colors";
import { validatePublishedLinkPlatform } from "@/lib/published-link-validation";
import { trackUsage } from "@/lib/usage/track";
import type { ReadyToPublishItem } from "@/lib/publish/ready";

// The Publish screen: every Ready To Publish post in the brand, one row each,
// with the link box right on the row. Post it on the platform, paste the live
// link, press Enter — the row turns Published and focus drops to the next one.
// Same write path as the content page's Publish dialog
// (POST /api/production-items/[id]/publish), so status, date and the
// downstream metrics fetch behave identically.

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
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const left = items.filter((i) => !published[i.id]).length;

  function focusNextOpen(from: number) {
    for (let j = from + 1; j < items.length; j++) {
      if (!published[items[j].id]) {
        inputs.current[j]?.focus();
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
      <div className="space-y-2">
        {items.map((item, idx) => (
          <PublishRow
            key={item.id}
            brand={brand}
            item={item}
            publishedLink={published[item.id] ?? null}
            inputRef={(el) => {
              inputs.current[idx] = el;
            }}
            autoFocus={idx === 0}
            onPublished={(link) => {
              setPublished((p) => ({ ...p, [item.id]: link }));
              focusNextOpen(idx);
            }}
          />
        ))}
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
    </div>
  );
}
