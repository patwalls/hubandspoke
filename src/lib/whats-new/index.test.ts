import { describe, it, expect } from "vitest";
import { unseenFor, popupFor, visibleTo, hrefFor, MAX_POPUP, POPUP_COOLDOWN_HOURS } from "./index";
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

describe("popupFor", () => {
  // Six cards shipped on one day popped up ~4 times per person: every card
  // reopened the dialog on the next page load. At most one pop-up a day now.
  const created = new Date("2026-01-01T00:00:00Z");
  const entries = [
    card("evening", "2026-10-31T18:30:00Z"),
    card("noon", "2026-10-31T12:00:00Z"),
    card("old", "2026-10-01T00:00:00Z"),
  ];
  const hoursAfter = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000);

  it("holds new cards while the last pop-up was dismissed less than a day ago", () => {
    const seen = new Date("2026-10-31T13:00:00Z"); // dismissed the noon card
    expect(popupFor(editor, seen, created, hoursAfter("2026-10-31T13:00:00Z", 6), entries)).toEqual([]);
  });

  it(`pops the held cards together once ${POPUP_COOLDOWN_HOURS} hours have passed`, () => {
    const seen = new Date("2026-10-31T13:00:00Z");
    const ids = popupFor(editor, seen, created, hoursAfter("2026-10-31T13:00:00Z", POPUP_COOLDOWN_HOURS), entries).map((e) => e.id);
    expect(ids).toEqual(["evening"]);
  });

  it("pops right away for someone who has never dismissed it", () => {
    const ids = popupFor(editor, null, new Date("2026-10-30T00:00:00Z"), new Date("2026-10-31T19:00:00Z"), entries).map((e) => e.id);
    expect(ids).toEqual(["evening", "noon"]);
  });

  it("measures the wait from when it was dismissed, not from a card stamped ahead of the clock", () => {
    // /api/whats-new/seen stamps the newest card's shippedAt when it is ahead of now.
    const seen = new Date("2026-10-31T20:00:00Z");
    expect(popupFor(editor, seen, created, new Date("2026-10-31T19:00:00Z"), entries)).toEqual([]);
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
