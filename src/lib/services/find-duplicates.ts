import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { extractContentId } from "@/lib/platform-url";

export interface DuplicatePair {
  pair_id: string;
  primary: {
    id: string;
    title: string | null;
    platform: string[] | null;
    published_date: string | null;
    views: number | null;
    sourceType: string | null;
  };
  secondary: {
    id: string;
    title: string | null;
    platform: string[] | null;
    published_date: string | null;
    views: number | null;
    sourceType: string | null;
  };
  confidence: number;
  reason: string;
}

/**
 * Normalize a title by removing extra whitespace and converting to lowercase
 * for comparison purposes.
 */
function normalizeTitle(title: string | null): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate similarity between two strings using a simple character-based approach.
 * Returns a number between 0 and 1, where 1 is exact match.
 */
function calculateStringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (longer.length === 0) return 1;

  // Simple Levenshtein-style distance (substring matching)
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }

  return matches / longer.length;
}

/**
 * Calculate matching confidence between two published items.
 * Returns 0-100 based on matching strength.
 */
function calculateConfidence(
  item1: {
    title: string | null;
    platform: string[] | null;
    publishedDate: string | null;
    publishedLink: string | null;
    postType: string | null;
  },
  item2: {
    title: string | null;
    platform: string[] | null;
    publishedDate: string | null;
    publishedLink: string | null;
    postType: string | null;
  }
): { confidence: number; reason: string } {
  let confidence = 0;
  const reasons: string[] = [];

  // Platform match (highest priority)
  const platform1 = (item1.platform || [])[0];
  const platform2 = (item2.platform || [])[0];
  if (platform1 && platform2 && platform1 === platform2) {
    confidence += 25;
    reasons.push("Same platform");
  }

  // Title similarity (check for 70%+ match)
  const title1 = normalizeTitle(item1.title);
  const title2 = normalizeTitle(item2.title);
  const titleSimilarity = calculateStringSimilarity(title1, title2);
  if (titleSimilarity >= 0.7) {
    confidence += Math.floor(titleSimilarity * 25); // Up to 25 points for title
    reasons.push(`Similar title (${Math.floor(titleSimilarity * 100)}%)`);
  }

  // Publish date within 24 hours
  if (item1.publishedDate && item2.publishedDate) {
    const date1 = new Date(item1.publishedDate).getTime();
    const date2 = new Date(item2.publishedDate).getTime();
    const diffMs = Math.abs(date1 - date2);
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours <= 24) {
      confidence += Math.max(0, 20 - Math.floor(diffHours)); // 20 points if same day, less if further apart
      reasons.push(`Published ${diffHours.toFixed(1)} hours apart`);
    }
  }

  // Video ID match (highest confidence)
  if (item1.publishedLink && item2.publishedLink) {
    const id1 = extractContentId(item1.postType, item1.publishedLink);
    const id2 = extractContentId(item2.postType, item2.publishedLink);
    if (id1 && id2 && id1 === id2) {
      confidence = 100;
      reasons.push("Identical video ID");
    }
  }

  return {
    confidence: Math.min(100, confidence),
    reason: reasons.join("; ") || "Similar content",
  };
}

/**
 * Find potential duplicate pairs for a brand.
 * Returns items grouped by platform + normalized title with confidence scores.
 */
export async function findDuplicates(
  brand: string,
  options: { limit?: number; onlyUnmerged?: boolean } = {}
): Promise<DuplicatePair[]> {
  const { limit = 50, onlyUnmerged = true } = options;

  // Fetch published items for the brand
  const items = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      publishedDate: productionItems.publishedDate,
      publishedLink: productionItems.publishedLink,
      postType: productionItems.postType,
      views: productionItems.views,
      sourceType: productionItems.sourceType,
      deletedAt: productionItems.deletedAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Published"),
        onlyUnmerged ? isNotNull(productionItems.publishedDate) : undefined
      )
    );

  // Filter out soft-deleted items
  const activeItems = items.filter((item) => !item.deletedAt);

  // Group by (platform, normalized_title)
  const groups = new Map<string, typeof activeItems>();
  for (const item of activeItems) {
    const platform = (item.platform || [])[0] || "unknown";
    const normalizedTitle = normalizeTitle(item.title);
    const key = `${platform}||${normalizedTitle}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(item);
  }

  // Find pairs with high confidence
  const pairs: DuplicatePair[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Compare all pairs within group
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const item1 = group[i];
        const item2 = group[j];

        const { confidence, reason } = calculateConfidence(item1, item2);

        // Only include pairs with >60% confidence
        if (confidence >= 60) {
          const pair_id = `${item1.id}-${item2.id}`;
          pairs.push({
            pair_id,
            primary: {
              id: item1.id,
              title: item1.title,
              platform: item1.platform,
              published_date: item1.publishedDate,
              views: item1.views,
              sourceType: item1.sourceType,
            },
            secondary: {
              id: item2.id,
              title: item2.title,
              platform: item2.platform,
              published_date: item2.publishedDate,
              views: item2.views,
              sourceType: item2.sourceType,
            },
            confidence,
            reason,
          });
        }
      }
    }
  }

  // Sort by confidence descending
  pairs.sort((a, b) => b.confidence - a.confidence);

  return pairs.slice(0, limit);
}
