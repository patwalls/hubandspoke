/**
 * Regression tests for the archive-failure path of
 * `descript-publish-and-archive`.
 *
 * The bug (prod, 2026-08-11): Descript finished the render successfully, but
 * the rendered MP4 was 242 MB — over `archiveRemoteToS3`'s 200 MB cap. The
 * archive call threw straight through the task without writing to the row,
 * so the item kept `descript_publish_job_id` set with both
 * `descript_published_at` and `descript_publish_error` NULL. Every consumer
 * reads that combination as "render in flight": the detail-page pill spun
 * with no Retry button, and the ops sweep's stuck-render detector (which
 * requires `descript_publish_error IS NULL`) couldn't see it. Item 3b015853
 * sat that way for ~24h across 12 silent queue retries.
 *
 * These hit the real local Postgres. Descript's API and the S3 archive step
 * are mocked so no credits are spent and nothing is uploaded.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/descript", () => ({
  DESCRIPT_EXPORT_URL_PREFIX:
    "https://production-273614-media-export.storage.googleapis.com/",
  fetchDescriptJob: vi.fn(),
  publishDescriptComposition: vi.fn(),
}));
// Partial mock — `MediaTooLargeError` must stay the real class so the
// task's `instanceof` check is exercised rather than stubbed.
vi.mock("@/lib/services/enrichment/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/enrichment/shared")>()),
  archiveRemoteToS3: vi.fn(),
}));

import { fetchDescriptJob } from "@/lib/descript";
import {
  archiveRemoteToS3,
  MediaTooLargeError,
} from "@/lib/services/enrichment/shared";
import { descriptPublishAndArchiveTask } from "./descript-publish-and-archive";
import { createTestProductionItem } from "@/test/factories";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

const mockedFetchJob = fetchDescriptJob as MockedFunction<
  typeof fetchDescriptJob
>;
const mockedArchive = archiveRemoteToS3 as MockedFunction<
  typeof archiveRemoteToS3
>;

const PUBLISH_JOB_ID = "project-media-publish-test-0001";
const DOWNLOAD_URL =
  "https://production-273614-media-export.storage.googleapis.com/rendered.mp4";

/** A Descript job that finished rendering successfully — the state the
 *  production incident was actually in. */
function successfulJob() {
  return {
    id: PUBLISH_JOB_ID,
    job_state: "stopped",
    result: { status: "success", download_url: DOWNLOAD_URL },
  } as unknown as Awaited<ReturnType<typeof fetchDescriptJob>>;
}

async function seedRenderingItem() {
  const item = await createTestProductionItem({
    descriptProjectId: "proj-test",
    descriptCompositionId: "comp-test",
    descriptPublishJobId: PUBLISH_JOB_ID,
  });
  return item;
}

function helpers() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    addJob: vi.fn().mockResolvedValue(undefined),
  } as never;
}

async function readPublishState(id: string) {
  const [row] = await db
    .select({
      publishJobId: productionItems.descriptPublishJobId,
      publishedAt: productionItems.descriptPublishedAt,
      publishError: productionItems.descriptPublishError,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  return row;
}

describe("descript-publish-and-archive — archive failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchJob.mockResolvedValue(successfulJob());
  });

  it("stamps descript_publish_error when the rendered MP4 is over the size cap", async () => {
    const item = await seedRenderingItem();
    mockedArchive.mockRejectedValue(new MediaTooLargeError(242_297_054));

    // Must NOT throw — oversize is deterministic, so retrying is pointless
    // and would leave a corpse in the queue.
    await expect(
      descriptPublishAndArchiveTask(
        { productionItemId: item.id, publishJobId: PUBLISH_JOB_ID },
        helpers(),
      ),
    ).resolves.toBeUndefined();

    const row = await readPublishState(item.id);
    // The row must stop claiming to be in flight — this is what puts the
    // Retry button on screen and what makes the ops sweep able to see it.
    expect(row.publishError).toBeTruthy();
    expect(row.publishError).toContain("231 MB");
    expect(row.publishError).toContain("200 MB");
    expect(row.publishedAt).toBeNull();
  });

  it("stamps the error and rethrows for transient archive failures", async () => {
    const item = await seedRenderingItem();
    mockedArchive.mockRejectedValue(new Error("socket hang up"));

    // A network blip IS worth retrying, so the task must still throw and let
    // graphile-worker back off.
    await expect(
      descriptPublishAndArchiveTask(
        { productionItemId: item.id, publishJobId: PUBLISH_JOB_ID },
        helpers(),
      ),
    ).rejects.toThrow("socket hang up");

    const row = await readPublishState(item.id);
    expect(row.publishError).toContain("socket hang up");
    expect(row.publishedAt).toBeNull();
  });
});
