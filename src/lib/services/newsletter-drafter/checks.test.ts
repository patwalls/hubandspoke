import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { checkLinks, collectUrls, findIssues } from "./checks";

const sb = DEFAULT_TEMPLATES["sunday breakfast"];
const sections = sb.sections.map((s) => ({ key: s.key, markdown: s.key === "coffee" ? "" : `**[Story](https://www.starterstory.com/${s.key})**\n\nText.` }));

describe("findIssues", () => {
  it("flags an empty required section, accepts an empty optional one, and checks the subject and preview text", () => {
    const base = { template: sb, sections, subject: "Short", previewText: "", specialCopy: "Copy", specialCopyFrom: "subtask" as const, screenshots: {} };
    const out = findIssues(base);
    expect(out.find((c) => c.sectionKey === "coffee")).toMatchObject({ level: "error", kind: "empty" });
    expect(out.find((c) => c.kind === "preview")).toMatchObject({ level: "warn" });
    expect(out.find((c) => c.kind === "subject")).toMatchObject({ level: "ok" });
    const optional = { ...sb, sections: sb.sections.map((s) => (s.key === "coffee" ? { ...s, optional: true } : s)) };
    expect(findIssues({ ...base, template: optional }).find((c) => c.sectionKey === "coffee")).toMatchObject({ level: "ok" });
    expect(findIssues({ ...base, subject: "x".repeat(70) }).find((c) => c.kind === "subject")).toMatchObject({ level: "warn" });
    expect(findIssues({ ...base, subject: "" }).find((c) => c.kind === "subject")).toMatchObject({ level: "error" });
  });

  it("flags placeholders, unpicked screenshots, example links and a sponsor on form-field copy", () => {
    const secs = [
      { key: "intro", markdown: "*[PLACEHOLDER: offer]*" },
      { key: "orange_juice", markdown: "Step one.\n\n*[Screenshot @ 1:00: the page]*\n\n[Grab it](https://example.com)" },
    ];
    const out = findIssues({ template: sb, sections: secs, subject: "s", previewText: "p", specialCopy: "Copy", specialCopyFrom: "focus_field", screenshots: {} });
    expect(out.find((c) => c.kind === "placeholder")?.sectionKey).toBe("intro");
    expect(out.find((c) => c.kind === "screenshot")?.message).toContain("1 screenshot spot");
    expect(out.find((c) => c.kind === "link")?.sectionKey).toBe("orange_juice");
    expect(out.find((c) => c.kind === "sponsor")).toMatchObject({ level: "warn" });
  });
});

describe("collectUrls + checkLinks", () => {
  it("collects unique links and images in order, and reports dead ones after HEAD then GET", async () => {
    const urls = collectUrls([
      { key: "a", markdown: "[x](https://ok.example/a) ![i](https://img.example/i.jpg) [x again](https://ok.example/a)" },
      { key: "b", markdown: "[dead](https://dead.example/)" },
    ]);
    expect(urls).toEqual([
      { url: "https://ok.example/a", sectionKey: "a", image: false },
      { url: "https://img.example/i.jpg", sectionKey: "a", image: true },
      { url: "https://dead.example/", sectionKey: "b", image: false },
    ]);
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method} ${u}`);
      if (u.startsWith("https://dead")) return new Response("", { status: 404 });
      if (u.includes("img")) return new Response("", { status: 200, headers: { "content-type": "image/jpeg" } });
      if (init?.method === "HEAD") return new Response("", { status: 405 });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const out = await checkLinks(urls, fetchFn);
    expect(out.map((c) => c.level)).toEqual(["ok", "ok", "error"]);
    expect(out[2].message).toContain("404");
    expect(calls).toContain("GET https://ok.example/a"); // HEAD 405 → GET
  });
});
