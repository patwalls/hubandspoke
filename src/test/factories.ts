/**
 * Test fixture factories for integration tests. Insert rows into the dev
 * Postgres (DATABASE_URL from .env.local — typically `hubandspoke_development`)
 * and auto-clean them in `afterEach` so suites don't leak state.
 *
 * Usage:
 *   ```ts
 *   import { describe, it, expect } from "vitest";
 *   import { createTestFormat, createTestProductionItem } from "@/test/factories";
 *
 *   describe("my feature", () => {
 *     it("does the thing", async () => {
 *       const format = await createTestFormat({ labelsAsOriginal: true });
 *       const item = await createTestProductionItem({ format: format.name });
 *       // ... assertions
 *       // No cleanup needed — `afterEach` deletes both rows.
 *     });
 *   });
 *   ```
 *
 * Importing this module registers an `afterEach` hook automatically. That
 * works because vitest's lifecycle hooks are scoped to the importing test
 * file; importing the factory in two files installs two independent hooks
 * (each cleaning only what THAT file created). No global state collision.
 *
 * Cleanup is LIFO with best-effort deletes — a failing teardown logs but
 * never blocks subsequent cleanup. FK relationships are handled by the
 * schema's `ON DELETE SET NULL` defaults (pillarContentItemId,
 * parentFormatId) so order rarely matters.
 *
 * For tests that need a unique user/account FK, this module dynamically
 * pulls the first admin user + an active starter-story X account at
 * suite-start time and caches the IDs. Override by passing
 * `editorUserId` / `accountId` directly when the test cares.
 */
import { afterEach } from "vitest";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  clipIdeas,
  contentDrafts,
  formats,
  productionItems,
  productionItemMedia,
  users,
  type ContentDraftContent,
} from "@/lib/db/schema";

type CleanupTable =
  | "productionItems"
  | "formats"
  | "clipIdeas"
  | "accounts"
  | "productionItemMedia"
  | "contentDrafts";
const created: Array<{ table: CleanupTable; id: string }> = [];

afterEach(async () => {
  // LIFO so children are deleted before parents. ON DELETE SET NULL on the
  // self-referential FKs covers stray references; this loop just keeps the
  // test DB tidy.
  while (created.length > 0) {
    const row = created.pop()!;
    try {
      if (row.table === "productionItems") {
        await db
          .delete(productionItems)
          .where(eq(productionItems.id, row.id));
      } else if (row.table === "formats") {
        await db.delete(formats).where(eq(formats.id, row.id));
      } else if (row.table === "clipIdeas") {
        await db.delete(clipIdeas).where(eq(clipIdeas.id, row.id));
      } else if (row.table === "accounts") {
        await db.delete(accounts).where(eq(accounts.id, row.id));
      } else if (row.table === "productionItemMedia") {
        await db
          .delete(productionItemMedia)
          .where(eq(productionItemMedia.id, row.id));
      } else if (row.table === "contentDrafts") {
        await db.delete(contentDrafts).where(eq(contentDrafts.id, row.id));
      }
    } catch (err) {
      console.error(
        `[test:cleanup] failed to delete ${row.table}/${row.id}:`,
        err,
      );
    }
  }
});

function trackCleanup(table: CleanupTable, id: string): void {
  created.push({ table, id });
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

let cachedTestUserId: string | null = null;
let cachedTestAccountId: string | null = null;

/**
 * Returns the user id every test should attach as editor when it doesn't
 * care about user identity. Caches across the whole suite. Falls back to
 * the oldest user in the DB; throws if the table is empty.
 */
export async function getTestUserId(): Promise<string> {
  if (cachedTestUserId) return cachedTestUserId;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!row) {
    throw new Error(
      "No users in DB — seed one with `node --env-file=.env.local scripts/seed-user.mjs e2e@local.test change-me-locally 'E2E Test'`",
    );
  }
  cachedTestUserId = row.id;
  return row.id;
}

/**
 * Returns an account id that satisfies the production_items.account_id FK
 * for the given (brand, platform). Caches the first match per call combo.
 * If no matching account exists in dev, throws with a clear message — the
 * test author should either seed one or pass `accountId` explicitly.
 */
export async function getTestAccountId(opts: {
  brand?: string;
  platform?: string;
} = {}): Promise<string> {
  const brandSlug = opts.brand ?? "starter-story";
  const platform = opts.platform ?? "x";
  if (cachedTestAccountId && brandSlug === "starter-story" && platform === "x") {
    return cachedTestAccountId;
  }
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        eq(brands.slug, brandSlug),
        eq(accounts.platform, platform),
        isNull(accounts.deletedAt),
      ),
    )
    .orderBy(asc(accounts.createdAt))
    .limit(1);
  if (!row) {
    throw new Error(
      `No ${brandSlug}/${platform} account in DB — seed one or pass accountId directly`,
    );
  }
  if (brandSlug === "starter-story" && platform === "x") {
    cachedTestAccountId = row.id;
  }
  return row.id;
}

export interface CreateTestAccountOptions {
  brand?: string;
  platform?: string;
  handle?: string;
  /** Zernio ConnectedAccount id — set for tests that need a TikTok account
   *  "connected" for draft posting. */
  zernioAccountId?: string | null;
}

/**
 * Insert a disposable `accounts` row so a test owns a fully-controlled set of
 * production items (the shared starter-story/x account from getTestAccountId
 * carries real data that would pollute candidate-gate assertions). Auto-cleans
 * in afterEach — delete the items it owns first (LIFO handles this when items
 * are created after the account).
 */
export async function createTestAccount(
  opts: CreateTestAccountOptions = {},
): Promise<typeof accounts.$inferSelect> {
  const brandSlug = opts.brand ?? "starter-story";
  const [brand] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.slug, brandSlug))
    .limit(1);
  if (!brand) {
    throw new Error(`No brand '${brandSlug}' in DB — seed brands first`);
  }
  const [row] = await db
    .insert(accounts)
    .values({
      brandId: brand.id,
      platform: opts.platform ?? "x",
      handle: opts.handle ?? `vitest-acct-${randomSuffix()}`,
      zernioAccountId: opts.zernioAccountId ?? null,
    })
    .returning();
  trackCleanup("accounts", row.id);
  return row;
}

export interface CreateTestMediaOptions {
  productionItemId: string;
  index?: number;
  kind?: string;
  s3Bucket?: string;
  s3Key?: string;
  contentType?: string;
  sizeBytes?: number | null;
  posterS3Key?: string | null;
  /** Origin marker — null = manual upload, a Descript prefix = clean export,
   *  a tiktokcdn URL = watermarked download. Drives clean-media classification. */
  sourceUrl?: string | null;
}

/**
 * Insert a `production_item_media` row (one carousel slide). Auto-cleans in
 * afterEach (and the FK cascade from the owning item covers it too). Defaults
 * to a single video slide at index 0.
 */
export async function createTestMedia(
  opts: CreateTestMediaOptions,
): Promise<typeof productionItemMedia.$inferSelect> {
  const [row] = await db
    .insert(productionItemMedia)
    .values({
      productionItemId: opts.productionItemId,
      index: opts.index ?? 0,
      kind: opts.kind ?? "video",
      s3Bucket: opts.s3Bucket ?? "vitest-bucket",
      s3Key: opts.s3Key ?? `vitest/${randomSuffix()}.mp4`,
      contentType: opts.contentType ?? "video/mp4",
      sizeBytes: opts.sizeBytes ?? 1024 * 1024,
      posterS3Key: opts.posterS3Key ?? null,
      sourceUrl: opts.sourceUrl ?? null,
    })
    .returning();
  trackCleanup("productionItemMedia", row.id);
  return row;
}

export interface CreateTestContentDraftOptions {
  productionItemId: string;
  content?: ContentDraftContent;
  version?: number;
  isCurrent?: boolean;
}

/**
 * Insert a `content_drafts` row (the current draft by default). Auto-cleans in
 * afterEach. Pass `content: { caption: "…" }` for TikTok tests.
 */
export async function createTestContentDraft(
  opts: CreateTestContentDraftOptions,
): Promise<typeof contentDrafts.$inferSelect> {
  const [row] = await db
    .insert(contentDrafts)
    .values({
      productionItemId: opts.productionItemId,
      version: opts.version ?? 1,
      isCurrent: opts.isCurrent ?? true,
      content: opts.content ?? {},
      fieldSchemaSnapshot: { version: 1, fields: [] },
      generatedBy: "vitest",
    })
    .returning();
  trackCleanup("contentDrafts", row.id);
  return row;
}

export interface CreateTestFormatOptions {
  brand?: string;
  name?: string;
  isClippableFormat?: boolean;
  labelsAsOriginal?: boolean;
  parentFormatId?: string | null;
  instructions?: string | null;
  viewThreshold?: number | null;
}

/**
 * Insert a `formats` row with sensible defaults. Auto-cleans in afterEach.
 * Names are randomized so re-running the same test doesn't trip the
 * brand+lower(name) unique index.
 */
export async function createTestFormat(
  opts: CreateTestFormatOptions = {},
): Promise<typeof formats.$inferSelect> {
  const name = opts.name ?? `vitest-format-${randomSuffix()}`;
  const [row] = await db
    .insert(formats)
    .values({
      name,
      brand: opts.brand ?? "starter-story",
      isClippableFormat: opts.isClippableFormat ?? false,
      labelsAsOriginal: opts.labelsAsOriginal ?? false,
      parentFormatId: opts.parentFormatId ?? null,
      instructions: opts.instructions ?? null,
      viewThreshold: opts.viewThreshold ?? null,
    })
    .returning();
  trackCleanup("formats", row.id);
  return row;
}

export interface CreateTestProductionItemOptions {
  brand?: string;
  title?: string;
  status?: string;
  format?: string | null;
  sourceType?: "original" | "repost" | "cross_post" | "repurposed";
  pillarContentItemId?: string | null;
  sourceClipIdeaId?: string | null;
  repostedFromItemId?: string | null;
  postType?: string | null;
  accountId?: string | null;
  platform?: string[];
  editorUserId?: string;
  publishedAt?: Date | null;
  /** date-only column; defaults to the calendar date of publishedAt. */
  publishedDate?: string | null;
  publishedLink?: string | null;
  platformContentId?: string | null;
  thumbnail?: string | null;
  hook?: string | null;
  /** Scheduled-status reconciliation fields. */
  scheduledAt?: Date | null;
  expectedPublishAt?: Date | null;
  scheduleNeedsAttentionAt?: Date | null;
  scheduledNoDate?: boolean | null;
  views?: number;
  descriptProjectId?: string | null;
  descriptProjectUrl?: string | null;
  descriptCompositionId?: string | null;
  descriptSeedCompositionId?: string | null;
  /** Publish-and-archive axis. `jobId set + publishedAt/error null` is the
   *  "render in flight" state the detail-page pill spins on. */
  descriptPublishJobId?: string | null;
  descriptPublishedAt?: Date | null;
  descriptPublishError?: string | null;
  mediaS3Bucket?: string | null;
  mediaS3Key?: string | null;
  contentBody?: string | null;
  /** youtube_id has a unique index — factories randomize when set to "auto". */
  youtubeId?: string | null;
  youtubeDownloadAttempts?: number;
}

/**
 * Insert a `production_items` row with sensible defaults. Auto-cleans in
 * afterEach. Defaults to a Published x-post `original` row on
 * @starter_story; override anything the test cares about.
 *
 * Titles are randomized so concurrent tests don't trip dedup on
 * platformContentId (which we leave null; unique index is partial).
 */
export async function createTestProductionItem(
  opts: CreateTestProductionItemOptions = {},
): Promise<typeof productionItems.$inferSelect> {
  const userId = opts.editorUserId ?? (await getTestUserId());
  const accountId =
    opts.accountId === undefined
      ? await getTestAccountId({ brand: opts.brand ?? "starter-story" })
      : opts.accountId;
  const publishedAt =
    opts.publishedAt === undefined ? new Date() : opts.publishedAt;
  const publishedDate =
    opts.publishedDate !== undefined
      ? opts.publishedDate
      : publishedAt
        ? publishedAt.toISOString().slice(0, 10)
        : null;
  const [row] = await db
    .insert(productionItems)
    .values({
      title: opts.title ?? `vitest-item-${randomSuffix()}`,
      brand: opts.brand ?? "starter-story",
      status: opts.status ?? "Published",
      sourceType: opts.sourceType ?? "original",
      format: opts.format ?? null,
      pillarContentItemId: opts.pillarContentItemId ?? null,
      sourceClipIdeaId: opts.sourceClipIdeaId ?? null,
      repostedFromItemId: opts.repostedFromItemId ?? null,
      postType: opts.postType ?? "x",
      accountId,
      platform: opts.platform ?? ["X"],
      publishedAt,
      publishedDate,
      publishedLink: opts.publishedLink ?? null,
      platformContentId: opts.platformContentId ?? null,
      thumbnail: opts.thumbnail ?? null,
      hook: opts.hook ?? null,
      scheduledAt: opts.scheduledAt ?? null,
      expectedPublishAt: opts.expectedPublishAt ?? null,
      scheduleNeedsAttentionAt: opts.scheduleNeedsAttentionAt ?? null,
      scheduledNoDate: opts.scheduledNoDate ?? false,
      editorUserId: userId,
      views: opts.views ?? 0,
      descriptProjectId: opts.descriptProjectId ?? null,
      descriptProjectUrl: opts.descriptProjectUrl ?? null,
      descriptCompositionId: opts.descriptCompositionId ?? null,
      descriptSeedCompositionId: opts.descriptSeedCompositionId ?? null,
      descriptPublishJobId: opts.descriptPublishJobId ?? null,
      descriptPublishedAt: opts.descriptPublishedAt ?? null,
      descriptPublishError: opts.descriptPublishError ?? null,
      mediaS3Bucket: opts.mediaS3Bucket ?? null,
      mediaS3Key: opts.mediaS3Key ?? null,
      contentBody: opts.contentBody ?? null,
      youtubeId:
        opts.youtubeId === "auto" ? `vitest-${randomSuffix()}` : (opts.youtubeId ?? null),
      youtubeDownloadAttempts: opts.youtubeDownloadAttempts ?? 0,
    })
    .returning();
  trackCleanup("productionItems", row.id);
  return row;
}

export interface CreateTestClipIdeaOptions {
  sourceProductionItemId: string;
  hook?: string;
  angle?: string;
  rationale?: string;
  startSec?: number;
  endSec?: number;
  status?: string;
  estimatedViews?: number;
  /** Name-string link to a format (brand derived via the source item). */
  targetFormat?: string | null;
  acceptedTargetFormat?: string | null;
}

/**
 * Insert a `clip_ideas` row tied to an existing production item. Auto-
 * cleans in afterEach. Used by tests that need to exercise the clip-
 * triage flow without firing the LLM.
 */
export async function createTestClipIdea(
  opts: CreateTestClipIdeaOptions,
): Promise<typeof clipIdeas.$inferSelect> {
  const [row] = await db
    .insert(clipIdeas)
    .values({
      sourceProductionItemId: opts.sourceProductionItemId,
      batchId: randomUUID(),
      startSec: String(opts.startSec ?? 0),
      endSec: String(opts.endSec ?? 30),
      hook: opts.hook ?? "vitest clip hook",
      angle: opts.angle ?? "vitest angle",
      rationale: opts.rationale ?? "vitest rationale",
      generatedBy: "vitest",
      promptVersion: 1,
      modelUsage: {},
      status: opts.status ?? "suggested",
      estimatedViews: opts.estimatedViews ?? null,
      targetFormat: opts.targetFormat ?? null,
      acceptedTargetFormat: opts.acceptedTargetFormat ?? null,
    })
    .returning();
  trackCleanup("clipIdeas", row.id);
  return row;
}

/**
 * Test-only helper: returns true if any of the suite's fixtures are still
 * tracked (i.e. afterEach hasn't fired yet, or cleanup failed mid-loop).
 * Mostly useful for sanity-checking that cleanup actually ran.
 */
export function pendingCleanupCount(): number {
  return created.length;
}

// Re-export the table types so test files don't need a second drizzle
// import when they want to assert on column shapes.
export { formats, productionItems, clipIdeas, isNotNull };
