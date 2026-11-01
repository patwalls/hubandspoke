import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createTestUser } from "@/test/factories";

// S-167: the session cookie is a JWT that outlives the users row. The guards
// must look the user up, so deleting or demoting a teammate takes effect on
// their next request — not on their next login.
const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { requireSession, requireAdmin } = await import("./auth-guards");

function sessionFor(id: string, role: "admin" | "creator") {
  return { user: { id, role, email: "x@test.local" }, expires: new Date(Date.now() + 86_400_000).toISOString() };
}

describe("requireSession / requireAdmin trust the DB, not the JWT", () => {
  beforeEach(() => authMock.mockReset());

  it("a live user passes", async () => {
    const u = await createTestUser({ role: "creator" });
    authMock.mockResolvedValue(sessionFor(u.id, "creator"));
    expect((await requireSession()).response).toBeUndefined();
  });

  it("a deleted user's still-valid JWT gets 401", async () => {
    const u = await createTestUser({ role: "creator" });
    authMock.mockResolvedValue(sessionFor(u.id, "creator"));
    await db.delete(users).where(eq(users.id, u.id));
    expect((await requireSession()).response?.status).toBe(401);
    expect((await requireAdmin()).response?.status).toBe(401);
  });

  it("a token for a user that never existed gets 401", async () => {
    authMock.mockResolvedValue(sessionFor(randomUUID(), "admin"));
    expect((await requireSession()).response?.status).toBe(401);
  });

  it("a demoted admin whose JWT still says admin gets 403 from requireAdmin", async () => {
    const u = await createTestUser({ role: "creator" });
    authMock.mockResolvedValue(sessionFor(u.id, "admin"));
    expect((await requireAdmin()).response?.status).toBe(403);
  });
});
