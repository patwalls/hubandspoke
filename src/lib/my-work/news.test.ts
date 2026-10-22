import { describe, it, expect } from "vitest";
import { ago, previewText, rowNews } from "./news";

const t = (h: number) => new Date(Date.UTC(2026, 9, 22, h));

describe("rowNews", () => {
  it("is null when nobody else said or did anything", () => {
    expect(rowNews({ myLastAt: t(5) })).toBeNull();
  });

  it("marks a comment newer than your last action as new", () => {
    const n = rowNews({ lastComment: { author: "Andrew", text: "Tighten the hook", at: t(6) }, myLastAt: t(5) });
    expect(n?.comment?.author).toBe("Andrew");
    expect(n?.isNew).toBe(true);
  });

  it("still shows an older comment, without the new dot", () => {
    const n = rowNews({ lastComment: { author: "Andrew", text: "ok", at: t(4) }, myLastAt: t(5) });
    expect(n?.comment?.text).toBe("ok");
    expect(n?.isNew).toBe(false);
  });

  it("treats everything as new on an item you never touched", () => {
    expect(rowNews({ lastComment: { author: "Sam", text: "hi", at: t(1) } })?.isNew).toBe(true);
  });

  it("shows a send-back only when it came after your last action", () => {
    expect(rowNews({ lastSendBack: { by: "Lauren", at: t(6) }, myLastAt: t(5) })?.sentBack?.by).toBe("Lauren");
    // You already re-worked it after the send-back: nothing to flag.
    expect(rowNews({ lastSendBack: { by: "Lauren", at: t(4) }, myLastAt: t(5) })).toBeNull();
  });

  it("ignores blank comments", () => {
    expect(rowNews({ lastComment: { author: "Sam", text: "  \n ", at: t(6) } })).toBeNull();
  });
});

describe("previewText", () => {
  it("collapses lines, decodes entities and caps the length", () => {
    expect(previewText("Sent back:\n\nfix &amp; re-export")).toBe("Sent back: fix & re-export");
    const long = previewText("x".repeat(300));
    expect(long.length).toBe(140);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("ago", () => {
  it("rounds to minutes, hours, days", () => {
    expect(ago(t(5), new Date(t(5).getTime() + 30_000))).toBe("1m");
    expect(ago(t(2), t(5))).toBe("3h");
    expect(ago(t(0), new Date(t(0).getTime() + 50 * 3600_000))).toBe("2d");
  });
});
