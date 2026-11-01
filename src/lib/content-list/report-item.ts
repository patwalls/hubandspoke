import { coverImageUrl } from "@/lib/cover-image";
import { REPORT_ITEM_TRIMMED_KEYS, type ProductionItem, type ReportItem } from "@/types";

/**
 * The Content list's wire shape for one row. The list renders ~1,300 rows a
 * brand, so every per-row key is paid ~1,300 times (Sentry "Large HTTP
 * payload" on /:brand/content).
 *
 * Covers: the row shows ONE image, chosen by `coverImageUrl` (poster →
 * image media → upstream thumbnail). The server has every input to that
 * choice, so it picks once and ships the answer as `posterUrl`; the other
 * candidates (a presigned URL for every archived video, ~575-char Instagram
 * CDN thumbnails, the raw S3 keys) never leave. Picking server-side also
 * means image posts get their durable archived cover — the client used to
 * lose `mediaContentType` to the trim and fall back to an expiring CDN URL.
 */
export function reportCoverKeys(items: ProductionItem[]): Set<string> {
  // Only the keys a cover can come from: posters, and media that is itself
  // an image with no poster. Archived videos aren't signed for the list.
  const keys = new Set<string>();
  for (const it of items) {
    if (it.posterS3Key) keys.add(it.posterS3Key);
    else if (it.mediaS3Key && it.mediaContentType?.startsWith("image/")) keys.add(it.mediaS3Key);
  }
  return keys;
}

export function slimReportItem(it: ProductionItem): ReportItem {
  // Sparse serialization: drop trimmed keys AND null-valued keys. Roughly
  // half of every item's ~90 keys are null. Consumers read fields with
  // nullish-tolerant patterns only, so undefined-for-null is identical there.
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it)) {
    if (v !== null && v !== undefined) slim[k] = v;
  }
  for (const k of REPORT_ITEM_TRIMMED_KEYS) delete slim[k];
  // The cover sources (thumbnail, mediaUrl, S3 keys) are in the trim list;
  // the one resolved cover rides as posterUrl.
  const cover = coverImageUrl(it);
  if (cover) slim.posterUrl = cover;
  else delete slim.posterUrl;
  // Account objects are deduplicated into `accountsById` — the same ~9
  // accounts embedded per-item were ~570 KB of the payload.
  delete slim.account;
  return slim as ReportItem;
}
