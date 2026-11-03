import { describe, expect, it } from "vitest";
import {
  composeWhisperPrompt,
  PROMPT_CONTINUATION_CHARS,
  PROMPT_MAX_CHARS,
  vocabularyLine,
} from "./whisper-prompt";

describe("vocabularyLine", () => {
  it("lists the brand's names once each, first spelling wins", () => {
    expect(vocabularyLine(["ChatGPT", "Rork", "chatgpt", "  Abmaxx  "])).toBe("Names: ChatGPT, Rork, Abmaxx.");
  });

  it("is empty when there is nothing to say", () => {
    expect(vocabularyLine([])).toBe("");
    expect(vocabularyLine(["", "  "])).toBe("");
  });

  it("keeps whole names within its budget, never half a word", () => {
    const line = vocabularyLine(["Alpha", "Bravo", "Charlie"], 20);
    expect(line).toBe("Names: Alpha, Bravo.");
    expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe("composeWhisperPrompt", () => {
  it("puts the item line, then the names, then the previous chunk's tail", () => {
    expect(
      composeWhisperPrompt({ item: 'Transcript of "My app".', vocabulary: ["Rork"], continuation: "and then we" }),
    ).toBe('Transcript of "My app". Names: Rork. and then we');
  });

  it("is the item line alone without names or a previous chunk (unchanged from before)", () => {
    expect(composeWhisperPrompt({ item: 'Transcript of "My app".' })).toBe('Transcript of "My app".');
  });

  // The old prompt kept the LAST 800 chars of item + tail, so a long
  // description pushed the title out. Names must survive a long item line.
  it("never lets a long item line crowd out the names or the continuation", () => {
    const item = `Transcript of "Title". ${"word ".repeat(400)}`;
    const tail = "x".repeat(1000) + " end";
    const prompt = composeWhisperPrompt({ item, vocabulary: ["ChatGPT", "Rork"], continuation: tail });
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(prompt.startsWith('Transcript of "Title".')).toBe(true);
    expect(prompt).toContain("Names: ChatGPT, Rork.");
    expect(prompt.endsWith(" end")).toBe(true);
    expect(prompt.length).toBeGreaterThan(PROMPT_CONTINUATION_CHARS);
  });
});
