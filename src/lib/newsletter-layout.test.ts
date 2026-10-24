import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "./newsletter-template";
import { layoutFor, layoutFromSections, newSlotKey, slotHeadings, slotKeys, withLayout } from "./newsletter-layout";

const sb = DEFAULT_TEMPLATES["sunday breakfast"];

describe("newsletter layouts", () => {
  it("builds the layout an older template implies: masthead, divider, pill headings, the sponsor in a box", () => {
    const l = layoutFromSections(sb);
    expect(l.content![0]).toMatchObject({ type: "image", attrs: { src: sb.style.mastheadImageUrl, href: sb.style.mastheadLinkUrl, background: "#EBECFC" } });
    expect(slotKeys(l)).toEqual(sb.sections.map((s) => s.key));
    const oj = l.content!.find((n) => n.type === "heading" && n.content?.[0].text === "The Orange Juice 🍊");
    expect(oj?.attrs).toEqual({ level: 2, pill: "#fed7aa" });
    expect(l.content!.find((n) => n.type === "callout")).toMatchObject({ attrs: { color: "#EBECFC" }, content: [{ type: "slot", attrs: { key: "special" } }] });
    expect(l.content!.filter((n) => n.type === "horizontalRule")).toHaveLength(sb.sections.length - 1);
    expect(layoutFor(sb)).toEqual(l);
  });

  it("reads each slot's heading from the design (the heading right above it, or above its box)", () => {
    const h = slotHeadings(layoutFromSections(sb));
    expect(h.orange_juice).toEqual({ text: "The Orange Juice 🍊", level: 2 });
    expect(h.special).toEqual({ text: "The Special 🍽️", level: 2 });
    expect(h.intro).toBeNull();
  });

  it("withLayout orders sections by slot, adds new ones, drops deleted ones, and takes headings from the design", () => {
    const layout = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 3, pill: null }, content: [{ type: "text", text: "Fresh" }] },
        { type: "slot", attrs: { key: "new_one" } },
        { type: "slot", attrs: { key: "orange_juice" } },
      ],
    };
    const t = withLayout(sb, layout);
    expect(t.sections.map((s) => s.key)).toEqual(["new_one", "orange_juice"]);
    expect(t.sections[0]).toMatchObject({ heading: "Fresh", headingLevel: 3, hint: "", kind: "text" });
    expect(t.sections[1]).toMatchObject({ heading: null, pillColor: null, story: "newest_video" });
    expect(t.layout).toBe(layout);
  });

  it("newSlotKey never collides", () => {
    expect(newSlotKey({ ...sb, sections: [...sb.sections, { ...sb.sections[0], key: `section_${sb.sections.length + 1}` }] })).toBe(`section_${sb.sections.length + 2}`);
  });
});

describe("layoutFor with a saved layout", () => {
  it("appends a section the layout has no slot for (with its heading), and keeps the design otherwise", () => {
    const layout = { type: "doc" as const, content: [{ type: "slot", attrs: { key: "intro" } }] };
    const t = { ...sb, layout, sections: [sb.sections[0], { ...sb.sections[1], heading: "The Orange Juice 🍊" }] };
    const l = layoutFor(t);
    expect(slotKeys(l)).toEqual(["intro", "orange_juice"]);
    expect(l.content![1]).toMatchObject({ type: "heading", content: [{ text: "The Orange Juice 🍊" }] });
    expect(layoutFor({ ...sb, layout, sections: [sb.sections[0]] })).toBe(layout);
  });
});

describe("layoutFromBeehiiv (Futurepedia's cards → a designed layout)", () => {
  it("turns each card into a bordered box with its label and sections, between the masthead and outro images", async () => {
    const { layoutFromBeehiiv } = await import("./newsletter-layout");
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    const l = layoutFromBeehiiv(fp)!;
    expect(l.content![0]).toMatchObject({ type: "image", attrs: { alt: "Futurepedia" } });
    expect(l.content![l.content!.length - 1]).toMatchObject({ type: "image" });
    const guide = l.content!.find((n) => n.type === "callout" && n.content?.[0]?.content?.[0]?.text === "{tool} Guide")!;
    expect(guide.attrs).toEqual({ color: "#FCFCFC", border: "#00AEEF" });
    expect(guide.content![0]).toMatchObject({ type: "heading", attrs: { level: 4, color: "#00AEEF" } });
    expect(guide.content!.map((n) => n.type)).toEqual(["heading", "slot", "slot", "heading", "slot"]); // label, article, why, "How We Did It", steps
    expect(slotKeys(l)).toEqual(fp.sections.map((s) => s.key));
    // A label isn't a section's name; the "How We Did It" heading is.
    const heads = slotHeadings(l);
    expect(heads.article).toBeNull();
    expect(heads.steps).toEqual({ text: "How We Did It", level: 3 });
  });
});
