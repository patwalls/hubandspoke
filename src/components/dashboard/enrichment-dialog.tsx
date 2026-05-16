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
  // Optional during the rollout — older code paths may not thread it
  // through. Required for delete/edit flows on the drafting surface.
  id?: string;
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
  /** YouTube video title, newsletter subject, etc. Filled by the per-platform
   *  enricher (`updates.title = …`). Distinct from the editorial draft
   *  title — this is what the published platform shows. */
  title?: string | null;
  /** Canonical post-type. Drives whether the newsletter-specific section
   *  renders. */
  postType?: string | null;
  /** Upstream thumbnail URL (CDN-hosted, may expire). Distinct from the
   *  archived `posterUrl` we keep in S3 — the upstream URL is what the
   *  content-list / queue cards still link to for cheap previews. */
  thumbnail?: string | null;
  /** When the published item went live. Filled by enrichers that have
   *  authoritative dates (YouTube /v1/youtube/video, Klaviyo campaigns).
   *  Shown in the dialog header so you don't have to close the modal to
   *  check what published-date is on file. */
  publishedAt?: string | null;
  publishedDate?: string | null;
  hook?: string | null;
  hookSource?: string | null;
  /** Which sweep / fallback wrote the current hook (e.g. `yt-enricher:v1`,
   *  `newsletter-enricher:v1`, `dispatch-hook:vision`). Useful for
   *  debugging which path won. */
  hookExtractor?: string | null;
  hookExtractedAt?: string | null;
  /** Verbatim burn-in text painted onto the cover/video itself (the bold
   *  overlay sentence above the speaker on a Reel). Distinct field from
   *  `hook`; for "Reel: Repackage Section w/ Hook" they're the same string,
   *  for other formats this may be null even when hook is set. */
  overlay?: string | null;
  coverDescription?: string | null;
  visionExtractedAt?: string | null;
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
  /** Pointer to the Whisper-extracted audio file in S3 — shown in the Media
   *  section so you can see everything we've archived, including the
   *  derivative artifact the transcript pipeline produced. */
  transcriptAudioS3Key?: string | null;
  transcriptModel?: string | null;
  transcriptDurationSec?: number | null;
  /** Newsletter-specific (Klaviyo). Surfaced in a dedicated section that
   *  only renders when any of these is set, so non-newsletter items don't
   *  show empty newsletter rows. */
  newsletterPreviewText?: string | null;
  newsletterBodyHtml?: string | null;
  newsletterRecipients?: number | null;
  klaviyoListId?: string | null;
  /** Full carousel — one entry per archived slide, index 0 == cover. Empty
   *  array for older items that were enriched pre-carousel support (the
   *  dialog falls back to the single `mediaUrl` / `posterUrl` fields). */
  media?: EnrichmentMedia[];
  onSynced: () => Promise<void> | void;
  /** "default" = outlined button (legacy chrome).
   *  "chip" = Pattern B — colored dot + dim text, matches the
   *  content-detail title-area state row. */
  variant?: "default" | "chip";
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

function hookSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "clip_idea":
      return "from clip idea";
    case "llm":
      return "extracted by LLM";
    case "vision":
      return "read from cover image";
    case "overlay":
      return "from on-video overlay";
    case "content_body":
      return "from post body";
    case "title":
      return "from title";
    case "manual":
      return "hand-edited";
    default:
      return source ?? "unknown source";
  }
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
    title,
    postType,
    thumbnail,
    publishedAt,
    publishedDate,
    hook,
    hookSource,
    hookExtractor,
    hookExtractedAt,
    overlay,
    coverDescription,
    visionExtractedAt,
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
    transcriptAudioS3Key,
    transcriptModel,
    transcriptDurationSec,
    newsletterPreviewText,
    newsletterBodyHtml,
    newsletterRecipients,
    klaviyoListId,
    media = [],
    onSynced,
    variant = "default",
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

  // Per-postType enrichment expectations. Different platforms produce
  // different artifacts:
  //   - X / LinkedIn / Threads / YT Community: text-primary. No
  //     transcript (no audio), no cover_description (no cover image).
  //   - Instagram Reel / TikTok / YouTube Shorts: video clips with hook
  //     overlay, transcript, cover thumb. All seven core signals.
  //   - YouTube Long: full pillar; same as a Reel but counts a real
  //     `title` too (Reels don't surface title separately).
  //   - Instagram Post: carousel — has hook + cover desc + caption +
  //     author + media (slides), but no transcript.
  //   - Instagram Story: 24h ephemeral — text + media, that's it.
  //   - Newsletter: an entirely different shape — preview text + body
  //     html + recipients + Klaviyo list id; the social signals don't
  //     apply.
  // The chip's percent is computed over the signals listed for the
  // item's postType, so a text-only LinkedIn post with hook + body +
  // author shows 100%, not 43% (which would be the case if we counted
  // it as missing media, transcript, cover_description, and title).
  type Signal =
    | "title"
    | "hook"
    | "cover_description"
    | "content_body"
    | "author"
    | "media"
    | "transcript"
    | "newsletter_preview"
    | "newsletter_body"
    | "newsletter_recipients";
  const EXPECTED: Partial<Record<string, Signal[]>> = {
    x: ["hook", "content_body", "author"],
    linkedin: ["hook", "content_body", "author"],
    threads: ["hook", "content_body", "author"],
    youtube_community: ["hook", "content_body", "author"],
    instagram_story: ["content_body", "author", "media"],
    instagram_post: ["hook", "cover_description", "content_body", "author", "media"],
    instagram_reel: ["hook", "cover_description", "content_body", "author", "media", "transcript"],
    tiktok: ["hook", "cover_description", "content_body", "author", "media", "transcript"],
    youtube_shorts: ["title", "hook", "cover_description", "content_body", "author", "media", "transcript"],
    youtube_long: ["title", "hook", "cover_description", "content_body", "author", "media", "transcript"],
    newsletter: ["title", "newsletter_preview", "newsletter_body", "author"],
  };
  // Default for unknown post types: the conservative core that the
  // generic enricher writes. Better to under-expect than over-ding.
  const expectedSignals: Signal[] =
    (postType && EXPECTED[postType]) || ["hook", "content_body", "author"];

  const signalPresent = (s: Signal): boolean => {
    switch (s) {
      case "title":
        return !!title?.trim();
      case "hook":
        return !!hook?.trim();
      case "cover_description":
        return !!coverDescription?.trim();
      case "content_body":
        return !!contentBody?.trim();
      case "author":
        return (
          !!authorHandle?.trim() || !!authorDisplayName?.trim()
        );
      case "media":
        return !!mediaS3Key || !!posterS3Key;
      case "transcript":
        return !!transcriptDurationSec;
      case "newsletter_preview":
        return !!newsletterPreviewText?.trim();
      case "newsletter_body":
        return !!newsletterBodyHtml?.trim();
      case "newsletter_recipients":
        return (newsletterRecipients ?? 0) > 0;
    }
  };

  const totalSignals = expectedSignals.length;
  const presentSignals = expectedSignals.filter(signalPresent).length;
  const enrichmentPercent =
    totalSignals === 0
      ? 100
      : Math.round((presentSignals / totalSignals) * 100);
  const isFullyEnriched =
    (totalSignals > 0 && presentSignals === totalSignals) ||
    !!enrichmentCompletedAt;
  const chipLabel = enrichmentError
    ? "Enrichment failed"
    : isFullyEnriched
      ? "Enriched"
      : presentSignals === 0
        ? "Not enriched"
        : `${enrichmentPercent}% enriched`;
  const chipDotColor = enrichmentError
    ? "bg-rose-500"
    : isFullyEnriched
      ? "bg-emerald-500"
      : presentSignals === 0
        ? "bg-muted-foreground/40"
        : "bg-amber-500";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={
              variant === "chip"
                ? cn(
                    "inline-flex h-6 items-center gap-1.5 px-1.5 text-xs " +
                      "text-muted-foreground hover:bg-muted/40 rounded-md " +
                      "cursor-pointer transition-colors",
                  )
                : buttonVariants({ variant: "outline", size: "sm" })
            }
            title="See the caption, media, and author data we've archived for this post"
          />
        }
      >
        {variant === "chip" ? (
          <>
            <span
              className={cn("size-1.5 rounded-full", chipDotColor)}
              aria-hidden
            />
            {chipLabel}
          </>
        ) : (
          <>
            <DatabaseIcon className="size-3.5" /> Enrichment
          </>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle>Enrichment data</DialogTitle>
            <span className="text-[11px] text-muted-foreground text-right">
              {enrichmentCompletedAt
                ? `Enriched ${fmtTimestamp(enrichmentCompletedAt)}`
                : "Not yet enriched"}
              {enrichmentAttempts != null && enrichmentAttempts > 0
                ? ` · ${enrichmentAttempts} attempt${enrichmentAttempts === 1 ? "" : "s"}`
                : ""}
              {(publishedAt || publishedDate) && (
                <>
                  <br />
                  Published{" "}
                  {publishedAt
                    ? fmtTimestamp(publishedAt)
                    : (publishedDate ?? "")}
                </>
              )}
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

          {/* Title / subject — populated by enrichers that have an
              authoritative title (YouTube /v1/youtube/video, Klaviyo
              campaign-message). For newsletters this IS the email subject
              line. Always render when set so you can confirm what the
              published platform shows vs. the editorial draft. */}
          {title && (
            <Section
              title={postType === "newsletter" ? "Subject" : "Title"}
              actions={<CopyButton text={title} />}
            >
              <p className="text-[13px] leading-snug font-medium">{title}</p>
            </Section>
          )}

          {/* Hook — verbatim scroll-stopper opening. Filled by the LLM sweep
              (short-form w/ transcript), clip-idea promotion, title/body
              fallback, or manual edit. */}
          <Section
            title="Hook"
            subtitle={
              hook
                ? [
                    hookSourceLabel(hookSource),
                    hookExtractor ? `via ${hookExtractor}` : null,
                    hookExtractedAt ? fmtTimestamp(hookExtractedAt) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
            actions={hook ? <CopyButton text={hook} /> : undefined}
          >
            {hook ? (
              <p className="text-[13px] leading-snug font-medium">{hook}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No hook extracted yet.
              </p>
            )}
          </Section>

          {/* On-video overlay — the verbatim burn-in text painted onto the
              cover/video itself. Distinct from the hook (which may be sourced
              from caption/transcript/title) so we can answer "does this clip
              have a designed overlay?" at a glance. */}
          {overlay && (
            <Section
              title="Overlay"
              subtitle="on-video burn-in text"
              actions={<CopyButton text={overlay} />}
            >
              <p className="text-[13px] leading-snug">{overlay}</p>
            </Section>
          )}

          {/* Cover description — Haiku vision summary of what the poster
              looks like. Independent signal from the hook. */}
          {(coverDescription || visionExtractedAt) && (
            <Section
              title="Cover description"
              subtitle={
                visionExtractedAt
                  ? `Vision · ${fmtTimestamp(visionExtractedAt)}`
                  : null
              }
            >
              {coverDescription ? (
                <p className="text-[13px] leading-snug">{coverDescription}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Processed, but no description returned.
                </p>
              )}
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

          {/* Newsletter (Klaviyo) — preview text + raw HTML body indicator
              + list / segment id. Renders only when any newsletter-specific
              field is populated, so non-newsletter items don't show empty
              rows. The HTML body itself isn't rendered inline (50KB+
              average) — the Copy button + size is the affordance for
              grabbing it. The plaintext body is already in the
              "Caption / body" section above. */}
          {(newsletterPreviewText ||
            newsletterBodyHtml ||
            klaviyoListId ||
            newsletterRecipients != null) && (
            <Section title="Newsletter">
              <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Preview text</dt>
                <dd>
                  {newsletterPreviewText ? (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] leading-snug">
                        {newsletterPreviewText}
                      </span>
                      <CopyButton text={newsletterPreviewText} />
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Body HTML</dt>
                <dd>
                  {newsletterBodyHtml ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {fmtBytes(newsletterBodyHtml.length)} stored
                      </span>
                      <CopyButton text={newsletterBodyHtml} />
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Recipients</dt>
                <dd>{fmtNumber(newsletterRecipients)}</dd>
                <dt className="text-muted-foreground">Klaviyo list / segment</dt>
                <dd className="font-mono text-xs">
                  {klaviyoListId || "—"}
                </dd>
              </dl>
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
              <dt className="text-muted-foreground">Thumbnail URL</dt>
              <dd className="font-mono text-xs break-all">
                {thumbnail ? (
                  <a
                    href={thumbnail}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {thumbnail}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted-foreground">Audio S3 key</dt>
              <dd className="font-mono text-xs break-all">
                {transcriptAudioS3Key || "—"}
                {transcriptAudioS3Key && (transcriptModel || transcriptDurationSec) && (
                  <span className="ml-2 text-muted-foreground font-sans">
                    {transcriptModel ? `(${transcriptModel}` : "("}
                    {transcriptDurationSec
                      ? `, ${Math.floor(transcriptDurationSec / 60)}:${String(Math.floor(transcriptDurationSec % 60)).padStart(2, "0")}`
                      : ""}
                    )
                  </span>
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
                          className="w-full rounded-md border border-border max-h-[480px] object-contain bg-black"
                        />
                      ) : m.url ? (
                        <img
                          src={m.url}
                          alt={`Slide ${m.index + 1}`}
                          className="w-full rounded-md border border-border max-h-[480px] object-contain"
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
