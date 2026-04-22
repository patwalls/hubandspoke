"use client";

import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  BadgeCheckIcon,
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  RefreshCwIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EnrichmentFields {
  captionFetched?: boolean;
  descriptionFetched?: boolean;
  posterArchived?: boolean;
  mediaArchived?: boolean;
  transcriptFetched?: boolean;
  authorFetched?: boolean;
}

export interface EnrichmentMedia {
  index: number;
  kind: string; // "image" | "video"
  url: string | null;
  posterUrl: string | null;
  contentType: string;
  sizeBytes: number | null;
}

interface Props {
  itemId: string;
  enrichmentCompletedAt?: string | null;
  enrichmentAttempts?: number | null;
  enrichmentError?: string | null;
  contentBody?: string | null;
  contentBodyFetchedAt?: string | null;
  contentBodySource?: string | null;
  contentMediaUrl?: string | null;
  description?: string | null;
  authorHandle?: string | null;
  authorDisplayName?: string | null;
  authorFollowerCount?: number | null;
  authorVerified?: boolean | null;
  posterUrl?: string | null;
  mediaUrl?: string | null;
  mediaContentType?: string | null;
  mediaSizeBytes?: number | null;
  mediaS3Key?: string | null;
  posterS3Key?: string | null;
  /** Full carousel — one entry per archived slide, index 0 == cover. Empty
   *  array for older items that were enriched pre-carousel support (the
   *  dialog falls back to the single `mediaUrl` / `posterUrl` fields). */
  media?: EnrichmentMedia[];
  onSynced: () => Promise<void> | void;
}

function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* no-op */
        }
      }}
      className="h-7 text-xs gap-1.5"
    >
      {copied ? (
        <>
          <CheckIcon className="size-3.5" /> Copied
        </>
      ) : (
        <>
          <CopyIcon className="size-3.5" /> Copy
        </>
      )}
    </Button>
  );
}

export function EnrichmentButton(props: Props) {
  const {
    itemId,
    enrichmentCompletedAt,
    enrichmentAttempts,
    enrichmentError,
    contentBody,
    contentBodyFetchedAt,
    contentBodySource,
    contentMediaUrl,
    description,
    authorHandle,
    authorDisplayName,
    authorFollowerCount,
    authorVerified,
    posterUrl,
    mediaUrl,
    mediaContentType,
    mediaSizeBytes,
    mediaS3Key,
    posterS3Key,
    media = [],
    onSynced,
  } = props;

  const [open, setOpen] = useState(false);
  const [syncState, setSyncState] = useState<
    | { kind: "idle" }
    | { kind: "syncing" }
    | { kind: "synced"; creditsSpent: number; fields: EnrichmentFields }
    | { kind: "skipped"; reason: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const handleSync = useCallback(async () => {
    setSyncState({ kind: "syncing" });
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/enrich?force=true&withMedia=true`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) {
        setSyncState({
          kind: "error",
          message: json?.error || `Sync failed (${res.status})`,
        });
        return;
      }
      if (json.skipped) {
        setSyncState({ kind: "skipped", reason: json.reason ?? "Skipped" });
      } else {
        setSyncState({
          kind: "synced",
          creditsSpent: json.creditsSpent ?? 0,
          fields: json.fields ?? {},
        });
      }
      await onSynced();
    } catch (err) {
      setSyncState({
        kind: "error",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }, [itemId, onSynced]);

  const isVideo = mediaContentType?.startsWith("video/");
  const isImage = mediaContentType?.startsWith("image/");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
            title="See the caption, media, and author data we've archived for this post"
          />
        }
      >
        <DatabaseIcon className="size-3.5" /> Enrichment
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle>Enrichment data</DialogTitle>
            <span className="text-[11px] text-muted-foreground">
              {enrichmentCompletedAt
                ? `Enriched ${fmtTimestamp(enrichmentCompletedAt)}`
                : "Not yet enriched"}
              {enrichmentAttempts != null && enrichmentAttempts > 0
                ? ` · ${enrichmentAttempts} attempt${enrichmentAttempts === 1 ? "" : "s"}`
                : ""}
            </span>
          </div>
        </DialogHeader>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncState.kind === "syncing"}
            className="h-7 text-xs gap-1.5"
            title="Re-run enrichment against ScrapeCreators to refresh caption, author, and archived media"
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                syncState.kind === "syncing" && "animate-spin"
              )}
            />
            {syncState.kind === "syncing" ? "Syncing…" : "Sync now"}
          </Button>
          {syncState.kind === "synced" && (
            <span className="text-[11px] text-muted-foreground">
              Synced · {syncState.creditsSpent} credits ·{" "}
              {Object.entries(syncState.fields)
                .filter(([, v]) => v)
                .map(([k]) => k.replace("Fetched", "").replace("Archived", ""))
                .join(", ") || "no changes"}
            </span>
          )}
          {syncState.kind === "skipped" && (
            <span className="text-[11px] text-muted-foreground">
              {syncState.reason}
            </span>
          )}
        </div>

        {syncState.kind === "error" && (
          <p className="text-xs text-red-600">{syncState.message}</p>
        )}
        {enrichmentError && syncState.kind !== "error" && (
          <p className="text-xs text-red-600">
            Last error: {enrichmentError}
          </p>
        )}

        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Author */}
          {authorHandle && (
            <Section title="Author">
              <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Handle</dt>
                <dd className="font-mono">@{authorHandle}</dd>
                {authorDisplayName && (
                  <>
                    <dt className="text-muted-foreground">Display name</dt>
                    <dd className="flex items-center gap-1.5">
                      {authorDisplayName}
                      {authorVerified && (
                        <BadgeCheckIcon
                          className="size-3.5 text-blue-500"
                          aria-label="Verified"
                        />
                      )}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Followers</dt>
                <dd>{fmtNumber(authorFollowerCount)}</dd>
              </dl>
            </Section>
          )}

          {/* Caption / body */}
          {contentBody ? (
            <Section
              title="Caption / body"
              subtitle={
                contentBodyFetchedAt
                  ? `Fetched ${fmtTimestamp(contentBodyFetchedAt)}${
                      contentBodySource ? ` · ${contentBodySource}` : ""
                    }`
                  : null
              }
              actions={<CopyButton text={contentBody} />}
            >
              <pre className="whitespace-pre-wrap break-words text-[13px] leading-snug font-sans">
                {contentBody}
              </pre>
            </Section>
          ) : (
            <Section title="Caption / body">
              <p className="text-xs text-muted-foreground">
                No caption stored yet.
              </p>
            </Section>
          )}

          {/* Description */}
          {description && (
            <Section
              title="Description (long-form)"
              actions={<CopyButton text={description} />}
            >
              <pre className="whitespace-pre-wrap break-words text-[13px] leading-snug font-sans">
                {description}
              </pre>
            </Section>
          )}

          {/* Media */}
          <Section title="Media">
            <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 text-sm mb-3">
              <dt className="text-muted-foreground">Poster S3 key</dt>
              <dd className="font-mono text-xs break-all">
                {posterS3Key || "—"}
              </dd>
              <dt className="text-muted-foreground">Media S3 key</dt>
              <dd className="font-mono text-xs break-all">
                {mediaS3Key || "—"}
              </dd>
              <dt className="text-muted-foreground">Content type</dt>
              <dd className="font-mono text-xs">{mediaContentType || "—"}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd>{fmtBytes(mediaSizeBytes)}</dd>
              <dt className="text-muted-foreground">Upstream URL</dt>
              <dd className="font-mono text-xs break-all">
                {contentMediaUrl ? (
                  <a
                    href={contentMediaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {contentMediaUrl}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </dl>

            {media.length > 0 ? (
              <>
                <div className="text-[11px] text-muted-foreground mb-2">
                  {media.length} slide{media.length === 1 ? "" : "s"} archived
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {media.map((m) => (
                    <figure key={m.index} className="space-y-1">
                      {m.kind === "video" && m.url ? (
                        <video
                          src={m.url}
                          poster={m.posterUrl ?? undefined}
                          controls
                          className="w-full rounded-md border border-border aspect-square object-cover"
                        />
                      ) : m.url ? (
                        <img
                          src={m.url}
                          alt={`Slide ${m.index + 1}`}
                          className="w-full rounded-md border border-border aspect-square object-cover"
                        />
                      ) : null}
                      <figcaption className="text-[11px] text-muted-foreground">
                        Slide {m.index + 1}
                        {m.kind === "video" ? " · video" : ""}
                        {m.sizeBytes ? ` · ${fmtBytes(m.sizeBytes)}` : ""}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              (posterUrl || mediaUrl) && (
                <div className="grid grid-cols-2 gap-3">
                  {posterUrl && (
                    <figure className="space-y-1">
                      <img
                        src={posterUrl}
                        alt="Poster"
                        className="w-full rounded-md border border-border object-cover"
                      />
                      <figcaption className="text-[11px] text-muted-foreground">
                        Poster (archived)
                      </figcaption>
                    </figure>
                  )}
                  {mediaUrl && (
                    <figure className="space-y-1">
                      {isVideo ? (
                        <video
                          src={mediaUrl}
                          controls
                          className="w-full rounded-md border border-border"
                        />
                      ) : isImage ? (
                        <img
                          src={mediaUrl}
                          alt="Media"
                          className="w-full rounded-md border border-border object-cover"
                        />
                      ) : (
                        <a
                          href={mediaUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          Open archived media
                        </a>
                      )}
                      <figcaption className="text-[11px] text-muted-foreground">
                        Archived media
                      </figcaption>
                    </figure>
                  )}
                </div>
              )
            )}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-background p-3 space-y-2">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
