import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createTestUser } from "@/test/factories";
import { loadWinnersEmailRecipients } from "./weekly-email";

// The Monday winners email goes to every active person (flag `everyone`,
// 2026-11-26) unless they turned it off on /winners-email.
describe("loadWinnersEmailRecipients", () => {
  it("includes a new active user by default, and drops one who turned it off or was deactivated", async () => {
    const fresh = await createTestUser();
    const off = await createTestUser();
    const gone = await createTestUser({ deactivated: true });
    await db.update(users).set({ winnersEmailEnabled: false }).where(eq(users.id, off.id));

    const ids = new Set((await loadWinnersEmailRecipients()).map((p) => p.id));
    expect(ids.has(fresh.id)).toBe(true);
    expect(ids.has(off.id)).toBe(false);
    expect(ids.has(gone.id)).toBe(false);
  });
});
