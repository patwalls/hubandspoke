import { describe, it, expect } from "vitest";
import { acceptsPastedLink, isPagePaste, pastedPostLink } from "./paste-to-publish";

describe("pastedPostLink", () => {
  it("takes a single post URL, trimmed, query string intact", () => {
    expect(pastedPostLink("  https://www.instagram.com/p/DfDnkcOD-uN/?utm_source=ig_web_copy_link\n")).toBe(
      "https://www.instagram.com/p/DfDnkcOD-uN/?utm_source=ig_web_copy_link",
    );
    expect(pastedPostLink("https://x.com/starter_story/status/2115590277733966144")).toBe(
      "https://x.com/starter_story/status/2115590277733966144",
    );
  });

  it("ignores text that isn't exactly one web link", () => {
    expect(pastedPostLink("")).toBeNull();
    expect(pastedPostLink(null)).toBeNull();
    expect(pastedPostLink("great hook, ship it")).toBeNull();
    expect(pastedPostLink("see https://youtu.be/abc")).toBeNull();
    expect(pastedPostLink("https://a.com/1 https://a.com/2")).toBeNull();
    expect(pastedPostLink("javascript:alert(1)")).toBeNull();
    expect(pastedPostLink("mailto:a@b.com")).toBeNull();
    expect(pastedPostLink("http://localhost:3000/x")).toBeNull();
  });
});

describe("isPagePaste", () => {
  const el = (tagName: string, extra: Partial<{ isContentEditable: boolean; inDialog: boolean }> = {}) => ({
    tagName,
    isContentEditable: extra.isContentEditable ?? false,
    closest: (sel: string) => (extra.inDialog && sel.includes("dialog") ? {} : null),
  });

  it("is a page paste on plain page content", () => {
    expect(isPagePaste(el("BODY"))).toBe(true);
    expect(isPagePaste(el("div"))).toBe(true);
    expect(isPagePaste(null)).toBe(true);
  });

  it("leaves pastes into fields, editors and dialogs alone", () => {
    expect(isPagePaste(el("INPUT"))).toBe(false);
    expect(isPagePaste(el("textarea"))).toBe(false);
    expect(isPagePaste(el("SELECT"))).toBe(false);
    expect(isPagePaste(el("DIV", { isContentEditable: true }))).toBe(false);
    expect(isPagePaste(el("DIV", { inDialog: true }))).toBe(false);
  });
});

describe("acceptsPastedLink", () => {
  it("only before the post is published or scheduled", () => {
    expect(acceptsPastedLink("Ready To Publish")).toBe(true);
    expect(acceptsPastedLink("Review")).toBe(true);
    expect(acceptsPastedLink(null)).toBe(true);
    expect(acceptsPastedLink("Published")).toBe(false);
    expect(acceptsPastedLink("Scheduled")).toBe(false);
  });
});
