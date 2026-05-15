import { describe, it, expect } from "vitest";
import {
  extractCrossPostCaptionRulesSection,
  extractCrossPostRulesSection,
  extractDescriptSection,
} from "./format-skill";

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

describe("extractCrossPostRulesSection", () => {
  const SKILL_WITH_RULES = `## Hook
Hook guidance for Claude.

### Cross Post Rules
- Instagram, TikTok and YT Shorts should be vertical
- Twitter and LinkedIn should be horizontal so make sure you apply these changes to Descript underlord etc

### Descript Clip & Pack Info
Apply the layout pack at https://example.com.
`;

  it("returns just the rules body", () => {
    const out = extractCrossPostRulesSection(SKILL_WITH_RULES);
    expect(out).not.toBeNull();
    expect(out).toContain("Instagram, TikTok and YT Shorts should be vertical");
    expect(out).toContain("Twitter and LinkedIn should be horizontal");
    // Adjacent sections must not leak through.
    expect(out).not.toContain("Hook guidance for Claude");
    expect(out).not.toContain("Apply the layout pack");
  });

  it("returns null when the Skill has no Cross Post Rules section", () => {
    const skill = "## Hook\nWrite a hook.\n\n## Avoid\nNo em dashes.";
    expect(extractCrossPostRulesSection(skill)).toBeNull();
  });

  it("returns null when the section is empty", () => {
    const skill = "### Cross Post Rules\n\n\n### Descript Clip & Pack Info\nbody";
    expect(extractCrossPostRulesSection(skill)).toBeNull();
  });

  it("matches case-insensitively (Skill markdown is editor-authored)", () => {
    const skill = `### cross post rules
- vertical for IG
`;
    const out = extractCrossPostRulesSection(skill);
    expect(out).toBe("- vertical for IG");
  });

  it("accepts h2 (## Cross Post Rules) as well as h3", () => {
    const skill = `## Cross Post Rules
- horizontal for Twitter
`;
    const out = extractCrossPostRulesSection(skill);
    expect(out).toBe("- horizontal for Twitter");
  });

  it("terminates at the next heading", () => {
    const skill = `### Cross Post Rules
- vertical for IG

## Some Next Section
Should not leak.`;
    const out = extractCrossPostRulesSection(skill);
    expect(out).toBe("- vertical for IG");
  });
});

describe("extractCrossPostCaptionRulesSection", () => {
  it("returns just the caption rules body", () => {
    const skill = `## Hook
Hook guidance for Claude.

### Cross Post Caption Rules
For X: use the on-screen hook verbatim as the body. No thread, no CTA, no bullets.

### Cross Post Rules
- Twitter should be horizontal
`;
    const out = extractCrossPostCaptionRulesSection(skill);
    expect(out).toBe(
      "For X: use the on-screen hook verbatim as the body. No thread, no CTA, no bullets.",
    );
    // Sibling sections must not leak through.
    expect(out).not.toContain("Hook guidance");
    expect(out).not.toContain("Twitter should be horizontal");
  });

  it("returns null when the section is absent", () => {
    expect(
      extractCrossPostCaptionRulesSection("## Hook\nDo the thing."),
    ).toBeNull();
  });

  it("returns null on empty section", () => {
    expect(
      extractCrossPostCaptionRulesSection("### Cross Post Caption Rules\n\n"),
    ).toBeNull();
  });

  it("does NOT pick up the framing rules section by accident", () => {
    const skill = `### Cross Post Rules
- Twitter should be horizontal
`;
    expect(extractCrossPostCaptionRulesSection(skill)).toBeNull();
  });

  it("matches case-insensitively and accepts h2", () => {
    const skill = `## cross post caption rules
- short hook only
`;
    expect(extractCrossPostCaptionRulesSection(skill)).toBe(
      "- short hook only",
    );
  });
});
