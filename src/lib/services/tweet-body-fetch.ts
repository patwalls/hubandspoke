import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { fetchTweetByUrl } from "@/lib/services/sc-fetchers";

export class TweetBodyFetchError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "not_found"
      | "no_link"
      | "not_a_tweet"
      | "upstream_missing"
      | "empty_body"
      | "unknown"
  ) {
    super(message);
    this.name = "TweetBodyFetchError";
  }
}

const TWITTER_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.twitter.com",
  "mobile.x.com",
]);

export function isTweetUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!TWITTER_HOSTS.has(host)) return false;
    return /\/status\/\d+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface TweetBodyFetchResult {
  productionItemId: string;
  contentBody: string;
  length: number;
  fetchedAt: Date;
}

export async function fetchTweetBody(
  productionItemId: string
): Promise<TweetBodyFetchResult> {
  const startedAt = new Date();

  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    throw new TweetBodyFetchError(
      `Production item ${productionItemId} not found`,
      "not_found"
    );
  }
  if (!item.publishedLink) {
    throw new TweetBodyFetchError(
      "Item has no published_link",
      "no_link"
    );
  }
  if (!isTweetUrl(item.publishedLink)) {
    throw new TweetBodyFetchError(
      `published_link is not a tweet URL: ${item.publishedLink}`,
      "not_a_tweet"
    );
  }

  try {
    const tweet = await fetchTweetByUrl(item.publishedLink);
    if (!tweet) {
      throw new TweetBodyFetchError(
        `ScrapeCreators returned no tweet for ${item.publishedLink}`,
        "upstream_missing"
      );
    }
    const body = tweet.legacy?.full_text ?? "";
    if (!body) {
      throw new TweetBodyFetchError(
        "Tweet legacy.full_text was empty",
        "empty_body"
      );
    }

    const fetchedAt = new Date();
    await db
      .update(productionItems)
      .set({
        contentBody: body,
        contentBodyFetchedAt: fetchedAt,
        contentBodySource: "scrape_creators",
        updatedAt: fetchedAt,
      })
      .where(eq(productionItems.id, productionItemId));

    await db.insert(syncLogs).values({
      syncType: "tweet-body-fetch",
      status: "success",
      itemsUpdated: 1,
      startedAt,
      completedAt: new Date(),
    });

    return {
      productionItemId,
      contentBody: body,
      length: body.length,
      fetchedAt,
    };
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: "tweet-body-fetch",
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}
