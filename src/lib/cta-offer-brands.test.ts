import { describe, it, expect } from "vitest";
import { brandShortName, commentKeywordFor, isBrandDmSlashtag, perPostDmSlashtag, usesRebrandlyDm } from "./cta-offer-brands";

describe("Rebrandly DM keyword brands", () => {
  it("MATG and MFM use Rebrandly; Starter Story doesn't", () => {
    expect(usesRebrandlyDm("matg")).toBe(true);
    expect(usesRebrandlyDm("my-first-million")).toBe(true);
    expect(usesRebrandlyDm("starter-story")).toBe(false);
  });

  it("a link belongs to a brand only with that brand's prefix", () => {
    expect(isBrandDmSlashtag("my-first-million", "mfm-ideavault")).toBe(true);
    expect(isBrandDmSlashtag("my-first-million", "matg-aimarketer")).toBe(false);
    expect(isBrandDmSlashtag("matg", "matg-")).toBe(false);
    expect(isBrandDmSlashtag("starter-story", "mfm-ideavault")).toBe(false);
  });

  it("per-post links are named <short>-p-<id> and never count as keywords", () => {
    const slug = perPostDmSlashtag("my-first-million", "3f9a2c1b-ecf1-4131-868e-303f98845a4a");
    expect(slug).toBe("mfm-p-3f9a2c1b");
    expect(isBrandDmSlashtag("my-first-million", slug)).toBe(false);
  });

  it("short names: mfm for My First Million, the slug for brands without one", () => {
    expect(brandShortName("my-first-million")).toBe("mfm");
    expect(brandShortName("matg")).toBe("matg");
    expect(brandShortName("the-hustle")).toBe("the-hustle");
  });

  it("the comment word drops the prefix; a leftover Starter Story slug on MATG isn't theirs", () => {
    expect(commentKeywordFor("my-first-million", "mfm-ideavault")).toBe("ideavault");
    expect(commentKeywordFor("matg", "playbook")).toBeNull();
    expect(commentKeywordFor("starter-story", "playbook")).toBe("playbook");
    expect(commentKeywordFor("matg", null)).toBeNull();
  });
});
