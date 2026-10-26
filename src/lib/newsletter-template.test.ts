import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, FUTUREPEDIA_VARIABLES, composeIssue, fillVariables, newsletterQueueTitle, templateChangeProblem, parseNewsletterTemplate, sectionHeadings, styleSchema, templateFor, variableNames, type NewsletterTemplate } from "./newsletter-template";

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
  optional: false,
  ...extra,
});
const T: NewsletterTemplate = {
  version: 1,
  variables: {},
  locked: false,
  styleNotes: null,
  layout: null,
  learnedAt: null,
  learnedFrom: null,
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
    expect(templateFor(" Sunday Breakfast ", null)).toEqual(DEFAULT_TEMPLATES["sunday breakfast"]);
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
  it("templates aren't locked any more: a saved locked flag changes nothing, and templateFor hands every template out unlocked", () => {
    const locked = { ...T, locked: true };
    expect(templateChangeProblem(locked, { ...locked, sections: locked.sections.slice(1) })).toBeNull();
    expect(templateChangeProblem(locked, { ...locked, locked: false })).toBeNull();
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    expect(templateFor("Futurepedia Newsletter", null)!.locked).toBe(false);
    expect(templateFor("Futurepedia Newsletter", { ...fp, locked: true })!.locked).toBe(false);
  });

  it("a beehiiv template not yet redesigned takes the Futurepedia look; a redesigned one keeps its own", () => {
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    expect(templateFor("Futurepedia Newsletter", null)!.style).toMatchObject({ pageBackground: "#F5F8FB", buttonColor: "#273653", linkColor: "#49adff" });
    const mine = { ...fp, layout: { type: "doc" as const, content: [] }, style: { ...fp.style, buttonColor: "#ff0000" } };
    expect(templateFor("Futurepedia Newsletter", mine)!.style.buttonColor).toBe("#ff0000");
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

describe("template fields ({name} tokens the drafter fills)", () => {
  it("finds {name} tokens once each, never the {{first_name}} personalization token", () => {
    expect(variableNames("{tool} Guide, then {tool} Guide Continued and {closer_1}")).toEqual(["tool", "closer_1"]);
    expect(variableNames("Hey {{first_name}}, {Tool} isn't one either")).toEqual([]);
  });

  it("fills a token with the issue's value, else the template's sample, else the fallback, else leaves it as written", () => {
    const t = { variables: { tool: { hint: "", sample: "ChatGPT Work" } } };
    expect(fillVariables("{tool} Guide", { tool: "Nano Banana" }, t)).toBe("Nano Banana Guide");
    expect(fillVariables("{tool} Guide", { tool: "  " }, t)).toBe("ChatGPT Work Guide");
    expect(fillVariables("{tool} Guide", null, null, () => "AI")).toBe("AI Guide");
    expect(fillVariables("{closer_1}", {}, t)).toBe("{closer_1}");
    expect(fillVariables("Hey {{first_name}}", { first_name: "x" }, t)).toBe("Hey {{first_name}}");
  });

  it("the Futurepedia default declares its fields and its headings resolve to what the sent issues print", () => {
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    expect(Object.keys(fp.variables)).toEqual(Object.keys(FUTUREPEDIA_VARIABLES));
    expect(fp.sections.find((s) => s.key === "steps")!.heading).toBe("{steps_heading}");
    expect(sectionHeadings(fp)).toEqual(["How We Did It", "Free Resource"]);
    expect(sectionHeadings(fp, { steps_heading: "How To Try It" })).toEqual(["How To Try It", "Free Resource"]);
    // Saved templates from before fields existed still parse (variables default to none).
    const { variables: _v, ...old } = fp;
    expect(parseNewsletterTemplate(old)?.variables).toEqual({});
  });
});
