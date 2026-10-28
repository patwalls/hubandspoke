import { describe, it, expect } from "vitest";
import type { Session } from "next-auth";
import {
  brandOfClipIdea,
  canEditBrand,
  editableBrandSlugs,
} from "@/lib/brand-access";
import {
  createTestClipIdea,
  createTestProductionItem,
  createTestUser,
} from "@/test/factories";

function sessionFor(user: { id: string; role: "admin" | "creator" }): Session {
  return { user: { id: user.id, role: user.role }, expires: "2099-01-01" };
}

describe("brand access", () => {
  it("admins can edit every brand, even with no brands assigned", async () => {
    const admin = await createTestUser({ role: "admin" });
    expect(await editableBrandSlugs(sessionFor(admin))).toBe("all");
    expect(await canEditBrand(sessionFor(admin), "futurepedia")).toBe(true);
  });

  it("creators can edit only their assigned brands", async () => {
    const creator = await createTestUser({ brands: ["starter-story"] });
    expect(await canEditBrand(sessionFor(creator), "starter-story")).toBe(true);
    expect(await canEditBrand(sessionFor(creator), "futurepedia")).toBe(false);
  });

  it("a creator with no brands is view-only everywhere", async () => {
    const creator = await createTestUser();
    expect(await canEditBrand(sessionFor(creator), "starter-story")).toBe(false);
  });

  it("a parent brand does not grant its family members", async () => {
    const creator = await createTestUser({ brands: ["futurepedia"] });
    expect(await canEditBrand(sessionFor(creator), "futurepedia")).toBe(true);
    expect(await canEditBrand(sessionFor(creator), "skill-leap")).toBe(false);
  });

  it("trusts the DB role over a stale JWT, so a demotion applies without re-login", async () => {
    // Signed in while admin, then demoted to creator: the JWT still says admin.
    const demoted = await createTestUser({ role: "creator", brands: ["matg"] });
    const staleSession = sessionFor({ id: demoted.id, role: "admin" });
    expect(await canEditBrand(staleSession, "matg")).toBe(true);
    expect(await canEditBrand(staleSession, "starter-story")).toBe(false);
    expect(await canEditBrand(undefined, "matg")).toBe(false);
  });

  it("resolves a clip idea's brand through its source item", async () => {
    const item = await createTestProductionItem({ brand: "starter-story" });
    const idea = await createTestClipIdea({ sourceProductionItemId: item.id });
    expect(await brandOfClipIdea(idea.id)).toBe("starter-story");
  });
});
