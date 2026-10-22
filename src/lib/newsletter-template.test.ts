import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, composeIssue, templateChangeProblem, parseNewsletterTemplate, styleSchema, templateFor, type NewsletterTemplate } from "./newsletter-template";

const sec = (key: string, heading: string | null, extra: Partial<NewsletterTemplate["sections"][number]> = {}) => ({
  key,
  heading,
  headingLevel: 2 as const,
  kind: "text" as const,
  hint: "",
  pillColor: null,
  boxColor: null,
  screenshots: false,
  look: "text" as const,
  thumbnail: false,
  bullets: "list" as const,
  ...extra,
});
const T: NewsletterTemplate = {
  version: 1,
  locked: false,
  style: styleSchema.parse({}),
  hubspot: null,
      beehiiv: null,
  sections: [sec("intro", null), sec("special", "The Special 🍽️", { kind: "sponsor" }), sec("tips", "Bonus Tips", { headingLevel: 3 })],
};

describe("newsletter templates", () => {
  it("rejects duplicate keys, bad keys and more than one sponsor section", () => {
    expect(parseNewsletterTemplate(T)).not.toBeNull();
    expect(parseNewsletterTemplate({ ...T, sections: [T.sections[0], T.sections[0]] })).toBeNull();
    expect(parseNewsletterTemplate({ ...T, sections: [{ ...T.sections[0], key: "Bad Key" }] })).toBeNull();
    expect(parseNewsletterTemplate({ ...T, sections: [T.sections[1], { ...T.sections[1], key: "other" }] })).toBeNull();
  });

  it("uses a saved template, else the built-in default for the format name, else none", () => {
    expect(templateFor("Anything", T)).toEqual(parseNewsletterTemplate(T));
    expect(templateFor(" Sunday Breakfast ", null)).toBe(DEFAULT_TEMPLATES["sunday breakfast"]);
    expect(templateFor("Playbook", { junk: true })).toBeNull();
  });

  it("every built-in default is itself a valid template", () => {
    for (const t of Object.values(DEFAULT_TEMPLATES)) expect(parseNewsletterTemplate(t)).not.toBeNull();
  });

  it("composes sections in template order with fixed headings, putting promo copy in the sponsor section", () => {
    const sections = [
      { key: "tips", markdown: "- **Do it**" },
      { key: "intro", markdown: "Hey!" },
      { key: "special", markdown: "agent's lead magnet" },
    ];
    expect(composeIssue(T, sections, null)).toBe("Hey!\n\n## The Special 🍽️\n\nagent's lead magnet\n\n### Bonus Tips\n\n- **Do it**");
    expect(composeIssue(T, sections, { copy: "Sponsor copy", landingUrl: "https://lp.example" })).toContain(
      "## The Special 🍽️\n\nSponsor copy\n\n**[Check it out HERE](https://lp.example)**",
    );
  });
});

describe("blockMarkdown", () => {
  it("fills each mapped email-tool block in template order, stacking sections that share a block, sponsor copy first", async () => {
    const { blockMarkdown, DEFAULT_TEMPLATES } = await import("./newsletter-template");
    const t = DEFAULT_TEMPLATES["sunday breakfast"];
    const out = blockMarkdown(
      t,
      [
        { key: "pancakes", markdown: "Pancakes teaser" },
        { key: "signoff", markdown: "That's it!" },
        { key: "special", markdown: "agent fallback" },
      ],
      { copy: "Free CRM", landingUrl: null },
    );
    expect(out[t.hubspot!.blocks.pancakes]).toBe("Pancakes teaser\n\nThat's it!");
    expect(out[t.hubspot!.blocks.special]).toBe("Free CRM");
    expect(Object.keys(out)).toHaveLength(2);
  });

  it("on a locked template allows only instruction changes (anything structural needs a template admin)", () => {
    const locked = { ...T, locked: true };
    const hintsOnly = { ...locked, sections: locked.sections.map((x) => ({ ...x, hint: `${x.hint} (shorter)` })) };
    expect(templateChangeProblem(locked, hintsOnly)).toBeNull();
    expect(templateChangeProblem(locked, { ...locked, sections: locked.sections.slice(1) })).toMatch(/locked/);
    expect(templateChangeProblem(locked, { ...locked, sections: locked.sections.map((x, i) => (i === 0 ? { ...x, heading: "New" } : x)) })).toMatch(/locked/);
    expect(templateChangeProblem(locked, { ...locked, locked: false })).toMatch(/locked/);
    // The built-in Futurepedia template (locked) vs the same template after a round trip through the API's validation.
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    const saved = parseNewsletterTemplate(JSON.parse(JSON.stringify({ ...fp, sections: fp.sections.map((x) => ({ ...x, hint: `${x.hint}!` })) })))!;
    expect(fp.locked).toBe(true);
    expect(templateChangeProblem(fp, saved)).toBeNull();
    expect(templateChangeProblem(fp, { ...saved, beehiiv: { ...saved.beehiiv!, layout: { ...saved.beehiiv!.layout, poll: false } } })).toMatch(/locked/);
    // Unlocked templates: anything goes.
    expect(templateChangeProblem(T, { ...T, sections: T.sections.slice(1) })).toBeNull();
  });

  it("keeps HubSpot-owned course names and colors as they are in the HubSpot email (instructions still editable)", () => {
    const sb = DEFAULT_TEMPLATES["sunday breakfast"];
    const oj = sb.sections.find((x) => sb.hubspot!.blocks[x.key] && x.heading)!;
    const edit = (patch: object) => ({ ...sb, sections: sb.sections.map((x) => (x.key === oj.key ? { ...x, ...patch } : x)) });
    expect(sb.locked).toBe(false);
    expect(templateChangeProblem(sb, edit({ hint: "New instructions" }))).toBeNull();
    expect(templateChangeProblem(sb, edit({ story: "any" }))).toBeNull();
    expect(templateChangeProblem(sb, edit({ heading: "The Smoothie" }))).toMatch(/HubSpot template email/);
    expect(templateChangeProblem(sb, edit({ pillColor: "#000000" }))).toMatch(/HubSpot template email/);
    expect(templateChangeProblem(sb, { ...sb, sections: sb.sections.filter((x) => x.key !== oj.key) })).toMatch(/can't be removed/);
    expect(templateChangeProblem(sb, { ...sb, sections: [...sb.sections].reverse() })).toMatch(/order/);
  });
});
