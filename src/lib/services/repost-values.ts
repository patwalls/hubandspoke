/**
 * Canonical builder for `production_items` rows with `sourceType = "repost"`.
 *
 * Both repost-creation paths — the manual `/api/production-items/[id]/repost`
 * route and the cron-driven `runEvergreenScan` — funnel through this helper
 * so the field set stays in lockstep. The strict `RepostSource` input type is
 * the validation: any candidate-source SELECT that omits a required column
 * fails to compile here, instead of silently writing NULL into the new row
 * (the bug class that hid 19 reposts from the Content view in May 2026).
 */
export interface RepostSource {
  id: string;
  brand: string;
  title: string | null;
  thumbnail: string | null;
  accountId: string;
  postType: string;
  platform: string[] | null;
  format: string | null;
  pillarContentItemId: string | null;
  pillarContentNotionId: string | null;
  evergreenReasoning?: string | null;
  // Single-cover columns mirrored onto the new repost so the X simulator's
  // fallback chain (`item.posterUrl ?? item.mediaUrl ?? item.thumbnail`) has
  // something to render on the redirect, before the carousel rows load.
  // `productionItemMedia` rows are also copied separately by `seedRepostContent`.
  mediaS3Bucket?: string | null;
  mediaS3Key?: string | null;
  mediaContentType?: string | null;
  posterS3Key?: string | null;
}

export interface RepostBuildOptions {
  utmCampaign: string;
  producerUserId: string;
  editorUserId: string;
}

export function buildRepostValues(source: RepostSource, opts: RepostBuildOptions) {
  return {
    brand: source.brand,
    title: source.title,
    thumbnail: source.thumbnail,
    status: "Idea" as const,
    accountId: source.accountId,
    postType: source.postType,
    platform: source.platform,
    sourceType: "repost" as const,
    repostedFromItemId: source.id,
    format: source.format,
    pillarContentNotionId: source.pillarContentNotionId,
    pillarContentItemId: source.pillarContentItemId,
    evergreenReasoning: source.evergreenReasoning ?? null,
    mediaS3Bucket: source.mediaS3Bucket ?? null,
    mediaS3Key: source.mediaS3Key ?? null,
    mediaContentType: source.mediaContentType ?? null,
    posterS3Key: source.posterS3Key ?? null,
    utmCampaign: opts.utmCampaign,
    producerUserId: opts.producerUserId,
    editorUserId: opts.editorUserId,
  };
}
