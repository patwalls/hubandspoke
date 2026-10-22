import { describe, expect, it } from "vitest";
import { voiceFromAuthors } from "./history";

describe("voiceFromAuthors", () => {
  it("reads Kevin or Saj from beehiiv author names, as strings or objects", () => {
    expect(voiceFromAuthors(["Kevin at Futurepedia"])).toBe("Kevin");
    expect(voiceFromAuthors([{ name: "Saj Adib" }])).toBe("Saj");
  });

  it("keeps any other byline as-is, and is null without authors", () => {
    expect(voiceFromAuthors(["Futurepedia Team"])).toBe("Futurepedia Team");
    expect(voiceFromAuthors(undefined)).toBeNull();
    expect(voiceFromAuthors([])).toBeNull();
  });
});
