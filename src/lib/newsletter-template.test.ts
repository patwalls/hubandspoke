import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, composeIssue, parseNewsletterTemplate, templateFor, type NewsletterTemplate } from "./newsletter-template";

const T: NewsletterTemplate = {
  version: 1,
  sections: [
    { key: "intro", heading: null, headingLevel: 2, kind: "text", hint: "" },
    { key: "special", heading: "The Special 🍽️", headingLevel: 2, kind: "sponsor", hint: "" },
    { key: "tips", heading: "Bonus Tips", headingLevel: 3, kind: "text", hint: "" },
  ],
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
