"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Check, ExternalLink, UploadIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postTypeLabel } from "@/lib/badge-colors";
import { validatePublishedLinkPlatform } from "@/lib/published-link-validation";
import { trackUsage } from "@/lib/usage/track";
import { READY_CHANGED_EVENT } from "@/lib/publish/events";
import { nextOpenId } from "@/lib/publish/next-open";
import { useCanEditBrand } from "@/components/brand-access";

// The content page's Cross-post tab, right after cross-posting: one link box
// per ready cross-post. Post it on the platform, paste the live link, press
// Enter — the row turns Published and the cursor drops to the next one, all
// without leaving the video's page. Same write path as the Publish screen
// and the content page's Publish dialog (POST /api/production-items/[id]/publish).

export interface PasteLinkRow {
  id: string;
  title: string | null;
  postType: string | null;
  accountHandle: string | null;
}

export function CrossPostPasteLinks({
  brand,
  rows,
}: {
  brand: string;
  rows: PasteLinkRow[];
}) {
  const [published, setPublished] = useState<Record<string, string>>({});
  // Mirror of `published` so two rows finishing back to back both land.
  const publishedRef = useRef<Record<string, string>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const left = rows.filter((r) => !published[r.id]).length;
  const firstOpen = rows.find((r) => !published[r.id]);

  return (
    <div
      data-testid="cross-post-publish-tab"
      className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {left === 0
            ? "All posted — every cross-post here has its live link."
            : `${left === 1 ? "1 cross-post is" : `${left} cross-posts are`} ready to publish. Posted one? Paste its live link and press Enter.`}
        </span>
        {firstOpen && (
          <Link
            href={`/${brand}/publish?focus=${firstOpen.id}`}
            onClick={() => trackUsage("publish:way-in:cross-post-tab", brand)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <UploadIcon className="size-3.5" /> Open Publish tab
          </Link>
        )}
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <PasteRow
            key={row.id}
            brand={brand}
            row={row}
            publishedLink={published[row.id] ?? null}
            inputRef={(el) => {
              inputs.current[row.id] = el;
            }}
            onPublished={(link) => {
              const next = { ...publishedRef.current, [row.id]: link };
              publishedRef.current = next;
              setPublished(next);
              window.dispatchEvent(new Event(READY_CHANGED_EVENT));
              const nextId = nextOpenId(
                rows.map((r) => r.id),
                row.id,
                next,
              );
              if (nextId) inputs.current[nextId]?.focus();
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PasteRow({
  brand,
  row,
  publishedLink,
  inputRef,
  onPublished,
}: {
  brand: string;
  row: PasteLinkRow;
  publishedLink: string | null;
  inputRef: (el: HTMLInputElement | null) => void;
  onPublished: (link: string) => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  // Pasting a link publishes the post — view-only users see the box disabled.
  const canEdit = useCanEditBrand(brand);
  // A link from another platform than the post is caught before it's saved.
  const mismatch = validatePublishedLinkPlatform(link.trim(), row.postType);
  const label = postTypeLabel(row.postType);

  async function publish() {
    const url = link.trim();
    if (!url || mismatch || !canEdit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/production-items/${row.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "publish", link: url }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't mark as published");
        return;
      }
      trackUsage("cross-post:link-pasted", brand);
      onPublished(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="cross-post-paste-row">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <Link
          href={`/${brand}/content/${row.id}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-xs hover:underline"
        >
          <span className="shrink-0 rounded bg-background px-1.5 py-0.5 font-medium text-foreground">
            {label}
          </span>
          {row.accountHandle ? (
            <span className="truncate text-muted-foreground">@{row.accountHandle}</span>
          ) : null}
        </Link>
        {publishedLink ? (
          <a
            href={publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-600 hover:underline sm:w-80 dark:text-emerald-400"
          >
            <Check className="size-3.5" />
            Published
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <Input
            ref={inputRef}
            aria-label={`Live link for the ${label} cross-post`}
            placeholder={`Paste the live ${label} link, then Enter`}
            value={link}
            disabled={busy || !canEdit}
            title={canEdit ? undefined : "View only — you don't have edit access to this brand"}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void publish();
              }
            }}
            className="h-8 bg-background text-xs sm:w-80"
          />
        )}
      </div>
      {mismatch && !publishedLink ? (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3" />
          {mismatch}
        </div>
      ) : null}
    </div>
  );
}
