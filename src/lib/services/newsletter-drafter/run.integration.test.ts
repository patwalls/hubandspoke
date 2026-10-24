import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { createTestFormat } from "@/test/factories";
import { createNewsletterDraft } from "./queries";
import { draftOwnedBy } from "./run";

describe("draftOwnedBy (does the run still own the draft?)", () => {
  it("matches a draft made by POST /api/newsletter-drafts (updated_at from Postgres now(), microseconds) read back into a JS Date", async () => {
    const fmt = await createTestFormat({ brand: "starter-story", name: "Vitest Owner Newsletter" });
    const created = (await createNewsletterDraft({ formatId: fmt.id, days: 7, userId: null })) as { id: string };
    try {
      const [row] = await db.select({ updatedAt: newsletterDrafts.updatedAt }).from(newsletterDrafts).where(eq(newsletterDrafts.id, created.id));
      const owned = await db.select({ id: newsletterDrafts.id }).from(newsletterDrafts).where(draftOwnedBy(created.id, row.updatedAt));
      expect(owned).toHaveLength(1);
      // Cancel / Redraft move updated_at (or the status): the run no longer owns it.
      await db.update(newsletterDrafts).set({ updatedAt: new Date(row.updatedAt.getTime() + 5) }).where(eq(newsletterDrafts.id, created.id));
      expect(await db.select({ id: newsletterDrafts.id }).from(newsletterDrafts).where(draftOwnedBy(created.id, row.updatedAt))).toHaveLength(0);
    } finally {
      await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, created.id));
    }
  });
});
