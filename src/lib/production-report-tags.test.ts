import { describe, it, expect } from "vitest";
import {
  PRODUCTION_REPORT_TAG,
  productionReportTag,
  productionReportTagsToExpire,
  touchedBrands,
} from "./production-report-tags";

// An edit used to expire every brand's In Production report at once (one
// shared tag), so ~10 brands went cold after every edit anywhere. A write
// that names its brand must expire only that brand and /all.
describe("productionReportTagsToExpire", () => {
  it("an edit in one brand expires that brand and /all, never the shared tag", () => {
    const tags = productionReportTagsToExpire(["starter-story"]);
    expect(tags).toEqual([productionReportTag("starter-story"), productionReportTag("all")]);
    expect(tags).not.toContain(PRODUCTION_REPORT_TAG);
    expect(tags).not.toContain(productionReportTag("matg"));
  });

  it("a move between brands expires both", () => {
    expect(productionReportTagsToExpire(["matg", "starter-story"])).toEqual([
      productionReportTag("matg"),
      productionReportTag("starter-story"),
      productionReportTag("all"),
    ]);
  });

  it("a write that can't name its brands expires every brand", () => {
    expect(productionReportTagsToExpire(null)).toEqual([PRODUCTION_REPORT_TAG]);
  });
});

describe("touchedBrands", () => {
  it("no brands given means every brand", () => {
    expect(touchedBrands(undefined)).toBeNull();
    expect(touchedBrands([])).toBeNull();
  });

  it("a post whose brand lookup came back empty falls back to every brand", () => {
    expect(touchedBrands([null, undefined, ""])).toBeNull();
  });

  it("drops blanks and repeats (an edit that didn't move the post)", () => {
    expect(touchedBrands(["starter-story", null, "starter-story"])).toEqual(["starter-story"]);
  });

  it("the /all sentinel is not a brand (it is always expired with any brand)", () => {
    expect(touchedBrands(["all"])).toBeNull();
    expect(touchedBrands(["all", "matg"])).toEqual(["matg"]);
  });
});
