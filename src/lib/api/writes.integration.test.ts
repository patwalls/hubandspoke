import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents } from "@/lib/db/schema";
import { createTestAccount, createTestProductionItem, createTestUser } from "@/test/factories";

// The impersonated handlers never reach next-auth, but the module is imported.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => void fn() };
});
vi.mock("@/lib/invalidate-report-caches", () => ({ invalidateReportCaches: () => {} }));

const { addComment, updateContent } = await import("./writes");
const { requireScope } = await import("./auth");
const { ApiError } = await import("./http");
type Principal = import("./auth").ApiPrincipal;

function principalFor(user: { id: string; email: string; name: string | null; role: "admin" | "creator" }, scopes: Array<"read" | "write">): Principal {
  return {
    user,
    auth: "api_key",
    key: { id: "k", name: "test", keyPrefix: "hs_live_test", createdAt: new Date() },
    scopes,
    rateLimit: { allowed: true, limit: 120, remaining: 100, resetAt: 0 },
  };
}

const BASE = "https://hs.test";

describe("requireScope", () => {
  it("a read-only key is refused with a 403 that says how to fix it", () => {
    const p = principalFor({ id: "u", email: "a@b.c", name: null, role: "creator" }, ["read"]);
    expect(() => requireScope(p, "write")).toThrowError(ApiError);
    try {
      requireScope(p, "write");
    } catch (e) {
      expect((e as InstanceType<typeof ApiError>).status).toBe(403);
      expect((e as Error).message).toContain("Can make changes");
    }
    expect(() => requireScope(principalFor(p.user, ["read", "write"]), "write")).not.toThrow();
  });
});

describe("updateContent (through the app's own handler)", () => {
  it("moves status and assigns an editor as the key's owner, writing the same activity events the UI does", async () => {
    const admin = await createTestUser({ role: "admin" });
    const editor = await createTestUser({ role: "creator" });
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    const item = await createTestProductionItem({ accountId: account.id, status: "Idea", editorUserId: null });
    const p = principalFor({ id: admin.id, email: admin.email, name: admin.name, role: "admin" }, ["read", "write"]);

    const out = await updateContent(p, item.id, { status: "Editing", editor_id: editor.id, title: "Renamed by API" }, BASE);
    expect(out.status).toBe("Editing");
    expect(out.editor?.id).toBe(editor.id);
    expect(out.title).toBe("Renamed by API");

    const events = await db.select().from(contentEvents).where(eq(contentEvents.contentItemId, item.id));
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual(expect.arrayContaining(["status_change", "editor_change", "content_changed"]));
    expect(events.every((e) => e.userId === admin.id)).toBe(true);
  });

  it("a creator without edit access to the brand gets the app's 403, not a silent write", async () => {
    const outsider = await createTestUser({ role: "creator", brands: [] });
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    const item = await createTestProductionItem({ accountId: account.id, status: "Idea" });
    const p = principalFor({ id: outsider.id, email: outsider.email, name: null, role: "creator" }, ["read", "write"]);
    await expect(updateContent(p, item.id, { status: "Editing" }, BASE)).rejects.toMatchObject({ type: "forbidden" });
  });

  it("the app's invariants hold: Published needs a url, Killed needs a reason, an empty patch is a 400", async () => {
    const admin = await createTestUser({ role: "admin" });
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    const item = await createTestProductionItem({ accountId: account.id, status: "Idea" });
    const p = principalFor({ id: admin.id, email: admin.email, name: null, role: "admin" }, ["read", "write"]);
    await expect(updateContent(p, item.id, { status: "Published" }, BASE)).rejects.toMatchObject({ type: "invalid_request" });
    await expect(updateContent(p, item.id, { status: "Killed" }, BASE)).rejects.toMatchObject({ type: "invalid_request" });
    await expect(updateContent(p, item.id, {}, BASE)).rejects.toMatchObject({ type: "invalid_request" });
  });
});

describe("addComment", () => {
  it("stores plain text as paragraphs and attributes it to the owner", async () => {
    const user = await createTestUser({ role: "creator" });
    const item = await createTestProductionItem({});
    const p = principalFor({ id: user.id, email: user.email, name: "API Tester", role: "creator" }, ["read", "write"]);
    const c = await addComment(p, item.id, { body: "Hook lands at 0:12.\n\nCut the <intro>.", at_sec: 12 });
    expect(c.author.id).toBe(user.id);
    expect(c.at_sec).toBe(12);
    expect(c.body_html).toBe("<p>Hook lands at 0:12.</p><p>Cut the &lt;intro&gt;.</p>");
    expect(c.body_text).toContain("Cut the <intro>.");
  });
});
