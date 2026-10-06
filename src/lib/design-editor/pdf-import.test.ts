import { describe, expect, it } from "vitest";
import { nearestCanvas, normalizeHex, normalizeImportedTemplate } from "./pdf-import";

const page = (elements: unknown[], background = "#111827") => ({ background, elements });

describe("normalizeImportedTemplate", () => {
  it("snaps a Canva 4:5 page to the portrait canvas and scales boxes and font sizes onto it", () => {
    const r = normalizeImportedTemplate({
      pageWidth: 980, pageHeight: 1226,
      pages: [page([{ type: "text", name: "Quote", x: 98, y: 490, w: 784, h: 98, text: "Hello world", sizePx: 36, color: "#ffffff", slot: "ai", hint: "The guest's opener." }])],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.canvas).toEqual({ width: 1080, height: 1350 });
    const el = r.doc.pages[0].elements[0];
    expect(el.type).toBe("text");
    if (el.type !== "text") return;
    expect(el.x).toBe(108);
    expect(el.w).toBe(864);
    expect(el.style.sizePx).toBe(40);
    expect(el.slot).toEqual({ kind: "ai", hint: "The guest's opener." });
  });

  it("splits highlight phrases into coloured spans and leaves the rest in the text colour", () => {
    const r = normalizeImportedTemplate({
      pageWidth: 1080, pageHeight: 1080,
      pages: [page([{ type: "text", name: "Q", x: 0, y: 0, w: 900, h: 100, text: "Made $40K in a month", color: "#FFFFFF", highlights: [{ phrase: "$40K", color: "#ffe14d" }, { phrase: "not in the text", color: "#ff0000" }] }])],
    });
    if (!r.ok) throw new Error(r.error);
    const el = r.doc.pages[0].elements[0];
    if (el.type !== "text") throw new Error("not text");
    expect(el.spans.map((s) => s.text).join("")).toBe("Made $40K in a month");
    expect(el.spans.find((s) => s.text.includes("$40K"))?.color).toBe("#FFE14D");
    expect(el.spans.filter((s) => s.color).length).toBe(1);
  });

  it("falls back to safe values for unknown fonts, bad colours and unknown slot kinds", () => {
    const r = normalizeImportedTemplate({
      pageWidth: 1080, pageHeight: 1080,
      pages: [page([
        { type: "text", name: "T", x: 0, y: 0, w: 500, h: 80, text: "Hi", fontId: "Poppins Regular", color: "white", slot: "subscribers" },
        { type: "picture", name: "Logo", x: 0, y: 0, w: 200, h: 80, slot: "placeholder" },
        { type: "picture", name: "Photo", x: 0, y: 0, w: 1080, h: 540 },
      ], "navy")],
    });
    if (!r.ok) throw new Error(r.error);
    const [t, logo, photo] = r.doc.pages[0].elements;
    expect(r.doc.pages[0].background).toBe("#000000");
    if (t.type !== "text") throw new Error("not text");
    expect(t.style.fontId).toBe("inter-regular");
    expect(t.style.color).toBe("#FFFFFF");
    expect(t.slot).toBeNull();
    expect(logo.slot).toBeNull();
    expect(photo.slot?.kind).toBe("frame");
  });

  it("keeps only one video per page and drops empty text", () => {
    const r = normalizeImportedTemplate({
      pageWidth: 1080, pageHeight: 1080,
      pages: [page([
        { type: "video", name: "Clip", x: 0, y: 0, w: 1080, h: 600 },
        { type: "video", name: "Clip 2", x: 0, y: 600, w: 1080, h: 480 },
        { type: "text", name: "Empty", x: 0, y: 0, w: 100, h: 100, text: "   " },
      ])],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.pages[0].elements.map((e) => e.type)).toEqual(["video"]);
  });

  it("rejects output without a page size or pages", () => {
    expect(normalizeImportedTemplate({ pages: [page([])] }).ok).toBe(false);
    expect(normalizeImportedTemplate({ pageWidth: 100, pageHeight: 100, pages: [] }).ok).toBe(false);
    expect(normalizeImportedTemplate("nope").ok).toBe(false);
  });
});

describe("normalizeHex / nearestCanvas", () => {
  it("normalises short and alpha hex", () => {
    expect(normalizeHex("#abc", "#000000")).toBe("#AABBCC");
    expect(normalizeHex("11223344", "#000000")).toBe("#112233");
    expect(normalizeHex("rgb(1,2,3)", "#000000")).toBe("#000000");
  });
  it("picks the nearest aspect", () => {
    expect(nearestCanvas(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(nearestCanvas(1080, 1900)).toEqual({ width: 1080, height: 1920 });
    expect(nearestCanvas(1000, 1000)).toEqual({ width: 1080, height: 1080 });
  });
});
