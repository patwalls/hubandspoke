import { describe, expect, it } from "vitest";
import { isMentionOnly } from "./extract-mentions";

const id = "3cd7fa7c-6efc-43fa-a9de-67c5f6bf2aaf";
const mention = (label = "Sam Editor") =>
  `<span data-type="mention" data-id="${id}" data-label="${label}" class="mention">@${label}</span>`;

describe("isMentionOnly", () => {
  it("is true for a bare @mention, the shape posted right after assigning", () => {
    expect(isMentionOnly(`<p>${mention()} </p>`)).toBe(true);
    expect(isMentionOnly(`<p>${mention()}&nbsp;</p>`)).toBe(true);
  });

  it("is true for several mentions and nothing else", () => {
    expect(isMentionOnly(`<p>${mention("A")} ${mention("B")}</p>`)).toBe(true);
  });

  it("is false once the comment says anything", () => {
    expect(isMentionOnly(`<p>${mention()} review &amp; publish</p>`)).toBe(false);
    expect(isMentionOnly(`<p>${mention()}</p><p>?</p>`)).toBe(false);
  });

  it("is false when the mention carries a link or an image", () => {
    expect(
      isMentionOnly(`<p>${mention()} <a href="https://example.com">x</a></p>`),
    ).toBe(false);
    expect(isMentionOnly(`<p>${mention()}</p><img src="/x.png">`)).toBe(false);
  });

  it("is false with no mention at all", () => {
    expect(isMentionOnly("<p></p>")).toBe(false);
    expect(isMentionOnly("<p>hello</p>")).toBe(false);
  });
});
