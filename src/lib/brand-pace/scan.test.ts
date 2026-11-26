import { describe, it, expect } from "vitest";
import { isScanningBrands, parseVisits, recordBrandVisit, SCAN_WINDOW_MS } from "./scan";

const T = 1_700_000_000_000;
const MIN = 60 * 1000;

describe("brand scan detection", () => {
  it("offers the link on the third different brand within the hour, not before", () => {
    let v = recordBrandVisit([], "starter-story", T);
    expect(isScanningBrands(v, T)).toBe(false);
    v = recordBrandVisit(v, "matg", T + 1 * MIN);
    expect(isScanningBrands(v, T + 1 * MIN)).toBe(false);
    v = recordBrandVisit(v, "futurepedia", T + 2 * MIN);
    expect(isScanningBrands(v, T + 2 * MIN)).toBe(true);
  });

  it("does not count reopening the same brand as scanning", () => {
    let v: ReturnType<typeof recordBrandVisit> = [];
    for (let i = 0; i < 6; i++) v = recordBrandVisit(v, i % 2 ? "matg" : "starter-story", T + i * MIN);
    expect(v).toHaveLength(2);
    expect(isScanningBrands(v, T + 6 * MIN)).toBe(false);
  });

  it("forgets brands opened more than an hour ago", () => {
    let v = recordBrandVisit([], "starter-story", T);
    v = recordBrandVisit(v, "matg", T + 5 * MIN);
    v = recordBrandVisit(v, "futurepedia", T + SCAN_WINDOW_MS + MIN);
    expect(v.map((x) => x.slug)).toEqual(["matg", "futurepedia"]);
    expect(isScanningBrands(v, T + SCAN_WINDOW_MS + MIN)).toBe(false);
  });

  it("never records /all — it is where the link leads, not a brand", () => {
    let v = recordBrandVisit([], "all", T);
    v = recordBrandVisit(v, "matg", T + MIN);
    v = recordBrandVisit(v, "all", T + 2 * MIN);
    v = recordBrandVisit(v, "futurepedia", T + 3 * MIN);
    expect(isScanningBrands(v, T + 3 * MIN)).toBe(false);
  });

  it("ignores junk and future timestamps in storage", () => {
    expect(parseVisits("not json")).toEqual([]);
    expect(parseVisits('{"slug":"x"}')).toEqual([]);
    expect(parseVisits('[{"slug":"a","at":1},{"slug":2,"at":3},null]')).toEqual([{ slug: "a", at: 1 }]);
    const v = [
      { slug: "a", at: T + 10 * MIN },
      { slug: "b", at: T + 10 * MIN },
      { slug: "c", at: T },
    ];
    expect(isScanningBrands(v, T)).toBe(false);
  });
});
