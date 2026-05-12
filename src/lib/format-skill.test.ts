import { describe, it, expect } from "vitest";
import { extractDescriptSection } from "./format-skill";

// `formats.instructions` (the Skill) is structured for two audiences:
// Claude reads sections like `## What this format is` / `## Hook` /
// `## Clip guidance` / `## Avoid` to decide what to do; Descript's
// Underlord reads `### Descript Clip & Pack Info` for the layout-pack
// URL and filler-word marking. Sending the whole Skill to Descript
// pollutes the Underlord prompt with editorial guidance it doesn't
// understand — this helper is the boundary.

const SAMPLE_SKILL = `## What this format is
Vertical 30–60s highlight clip from the pillar interview.

## Hook
Come up with the hook that will create curiosity on social media.

## Clip guidance
Pick a punchy moment. Start on a clean sentence boundary.

## Avoid
No filler intros.

### Descript Clip & Pack Info
Apply the layout pack at https://web.descript.com/pack/abc to this composition.

Set the hook text track at the top of the composition to: "{{hook}}".

Inside the composition, mark filler words as IGNORED. DO NOT DELETE.
`;

describe("extractDescriptSection", () => {
  it("returns just the body under '### Descript Clip & Pack Info'", () => {
    const out = extractDescriptSection(SAMPLE_SKILL);
    expect(out).toContain("Apply the layout pack at https://web.descript.com");
    expect(out).toContain('"{{hook}}"');
    expect(out).toContain("filler words as IGNORED");
    // Editorial sections meant for Claude must NOT leak through.
    expect(out).not.toContain("What this format is");
    expect(out).not.toContain("Hook");
    expect(out).not.toContain("Clip guidance");
    expect(out).not.toContain("Avoid");
  });

  it("returns the whole input when no Descript section heading exists (back-compat)", () => {
    const skill = "## Hook\nWrite the hook here.\n\n## Clip guidance\nDo the thing.";
    expect(extractDescriptSection(skill)).toBe(skill);
  });

  it("terminates the section at the next heading of equal or higher level", () => {
    const skill = `### Descript Clip & Pack Info
Apply the layout pack at https://web.descript.com/x.

## Some H2 After
This should not be included.
`;
    const out = extractDescriptSection(skill);
    expect(out).toContain("Apply the layout pack at https://web.descript.com/x.");
    expect(out).not.toContain("Some H2 After");
    expect(out).not.toContain("This should not be included.");
  });

  it("accepts h2 (## Descript Clip & Pack Info) as well as h3", () => {
    const skill = `## Descript Clip & Pack Info
Apply the layout pack at https://web.descript.com/y.

## Another section
should not include
`;
    const out = extractDescriptSection(skill);
    expect(out).toContain("Apply the layout pack at https://web.descript.com/y.");
    expect(out).not.toContain("Another section");
  });

  it("matches case-insensitively (Skill markdown is editor-authored, sloppy is fine)", () => {
    const skill = `### descript clip & pack info
Apply the layout pack at https://web.descript.com/z.
`;
    const out = extractDescriptSection(skill);
    expect(out).toContain("Apply the layout pack at https://web.descript.com/z.");
  });

  it("includes everything to end-of-string when the Descript section is last", () => {
    // The realistic case — Pack info is typically the final section.
    const out = extractDescriptSection(SAMPLE_SKILL);
    expect(out.trim().endsWith("DO NOT DELETE.")).toBe(true);
  });

  it("trims surrounding whitespace from the extracted section", () => {
    const skill = `### Descript Clip & Pack Info


Apply the layout pack.


`;
    expect(extractDescriptSection(skill)).toBe("Apply the layout pack.");
  });
});
