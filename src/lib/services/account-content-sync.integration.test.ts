import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { createTestAccount } from "@/test/factories";
import { syncAccountContent } from "./account-content-sync";

describe("syncAccountContent — deleted accounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression: a deleted @matgpod row stayed is_active=true and kept syncing
  // daily, because the success path re-activates inactive accounts.
  it("is a no-op for an account deleted from the brand's account list", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("deleted account must not call Scrape Creators");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const acct = await createTestAccount({
      platform: "instagram",
      isActive: true,
      deletedAt: new Date(),
    });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.errorMessage).toBeUndefined();
    expect(result.pagesFetched).toBe(0);

    const [after] = await db
      .select({
        lastContentSyncAt: accounts.lastContentSyncAt,
        lastContentSyncError: accounts.lastContentSyncError,
      })
      .from(accounts)
      .where(eq(accounts.id, acct.id));
    expect(after.lastContentSyncAt).toBeNull();
    expect(after.lastContentSyncError).toBeNull();
  });
});
