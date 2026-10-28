import { describe, it, expect } from "vitest";
import { unseenFor, visibleTo, hrefFor, MAX_POPUP } from "./index";
import { WHATS_NEW, type WhatsNewEntry } from "./entries";

const card = (id: string, shippedAt: string, extra: Partial<WhatsNewEntry> = {}): WhatsNewEntry => ({
  id,
  shippedAt,
  kind: "feature",
  title: id,
  body: id,
  ...extra,
});

const editor = { email: "editor@example.com", role: "creator" };
const admin = { email: "boss@example.com", role: "admin" };

describe("unseenFor", () => {
  const entries = [card("new", "2026-10-20T00:00:00Z"), card("old", "2026-10-01T00:00:00Z")];

  it("shows only cards shipped after the last dismissal", () => {
    const seen = new Date("2026-10-10T00:00:00Z");
    expect(unseenFor(editor, seen, new Date("2026-01-01"), entries).map((e) => e.id)).toEqual(["new"]);
  });

  it("falls back to account creation, so new teammates don't get the backlog", () => {
    const created = new Date("2026-10-15T00:00:00Z");
    expect(unseenFor(editor, null, created, entries).map((e) => e.id)).toEqual(["new"]);
  });

  it(`caps the pop-up at ${MAX_POPUP} cards`, () => {
    const many = Array.from({ length: 9 }, (_, i) => card(`c${i}`, `2026-10-${10 + i}T00:00:00Z`));
    expect(unseenFor(editor, null, new Date("2026-01-01"), many)).toHaveLength(MAX_POPUP);
  });
});

describe("visibleTo", () => {
  it("hides admin-only cards from non-admins", () => {
    const entries = [card("a", "2026-10-20T00:00:00Z", { audience: { adminOnly: true } })];
    expect(visibleTo(editor, entries)).toHaveLength(0);
    expect(visibleTo(admin, entries)).toHaveLength(1);
  });

  it("hides a flagged card from people without the flag", () => {
    const entries = [card("f", "2026-10-20T00:00:00Z", { audience: { flag: "newsletterTemplateAdmin" } })];
    expect(visibleTo(editor, entries)).toHaveLength(0);
    expect(visibleTo({ email: "sam@starterstory.com", role: "admin" }, entries)).toHaveLength(1);
  });
});

describe("hrefFor", () => {
  it("fills the brand placeholder", () => {
    expect(hrefFor(card("x", "2026-10-20T00:00:00Z", { href: "/[brand]/queue" }), "matg")).toBe("/matg/queue");
  });
});

describe("WHATS_NEW", () => {
  it("is newest first with unique ids", () => {
    const ids = WHATS_NEW.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = WHATS_NEW.map((e) => new Date(e.shippedAt).getTime());
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
