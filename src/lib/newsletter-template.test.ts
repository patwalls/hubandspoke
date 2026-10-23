import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, composeIssue, newsletterQueueTitle, templateChangeProblem, parseNewsletterTemplate, styleSchema, templateFor, type NewsletterTemplate } from "./newsletter-template";

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
  linkButtons: false,
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

describe("templateChangeProblem", () => {
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

  it("HubSpot formats: the look is Hub & Spoke's now — names, colors and order change freely; only which HubSpot email the drafts are made from is fixed", () => {
    const sb = DEFAULT_TEMPLATES["sunday breakfast"];
    const oj = sb.sections.find((x) => x.heading)!;
    const edit = (patch: object) => ({ ...sb, sections: sb.sections.map((x) => (x.key === oj.key ? { ...x, ...patch } : x)) });
    expect(sb.locked).toBe(false);
    expect(templateChangeProblem(sb, edit({ hint: "New instructions" }))).toBeNull();
    expect(templateChangeProblem(sb, edit({ heading: "The Smoothie", pillColor: "#000000" }))).toBeNull();
    expect(templateChangeProblem(sb, { ...sb, sections: sb.sections.filter((x) => x.key !== oj.key) })).toBeNull();
    expect(templateChangeProblem(sb, { ...sb, style: { ...sb.style, linkColor: "#ff0000" } })).toBeNull();
    expect(templateChangeProblem(sb, { ...sb, hubspot: { ...sb.hubspot!, templateEmailId: "1" } })).toMatch(/HubSpot template link/);
  });
});

describe("newsletterQueueTitle (the queue names an edition like its email tool does)", () => {
  const hubspot = DEFAULT_TEMPLATES["sunday breakfast"];
  const beehiiv = DEFAULT_TEMPLATES["futurepedia newsletter"];

  it("HubSpot formats: the email name from the mapping, needs the send date", () => {
    expect(newsletterQueueTitle(hubspot, { brandLabel: "Starter Story", sendDate: "2026-10-25", subject: "x" })).toBe("Starter Story | Newsletter | October 25");
    expect(newsletterQueueTitle(hubspot, { brandLabel: "Starter Story", sendDate: null, subject: "x" })).toBeNull();
  });

  it("beehiiv formats: the subject line; nothing until there is one", () => {
    expect(newsletterQueueTitle(beehiiv, { brandLabel: "Futurepedia", sendDate: "2026-11-03", subject: "  Give Your Claude Videos a Voice " })).toBe("Give Your Claude Videos a Voice");
    expect(newsletterQueueTitle(beehiiv, { brandLabel: "Futurepedia", sendDate: "2026-11-03", subject: "" })).toBeNull();
    expect(newsletterQueueTitle(null, { brandLabel: "X", sendDate: "2026-11-03", subject: "s" })).toBeNull();
  });
});
