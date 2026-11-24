import { describe, it, expect } from "vitest";
import { editorEscapeStep, editorIgnoresClose, isTypingTarget } from "./dismiss";

describe("editorIgnoresClose", () => {
  it("ignores a press outside and focus leaving", () => {
    expect(editorIgnoresClose("outside-press")).toBe(true);
    expect(editorIgnoresClose("focus-out")).toBe(true);
  });
  it("still closes on the close button, Esc (decided separately) and code", () => {
    expect(editorIgnoresClose("close-press")).toBe(false);
    expect(editorIgnoresClose("escape-key")).toBe(false);
    expect(editorIgnoresClose("imperative-action")).toBe(false);
  });
});

describe("editorEscapeStep", () => {
  const none = { typing: false, wordSelection: false, stageSelection: false };
  it("closes only when nothing is left to let go of", () => {
    expect(editorEscapeStep(none)).toBe("close");
  });
  it("lets go of one thing at a time: field, then words, then the stage layer", () => {
    expect(editorEscapeStep({ typing: true, wordSelection: true, stageSelection: true })).toBe("leave-field");
    expect(editorEscapeStep({ ...none, wordSelection: true, stageSelection: true })).toBe("drop-words");
    expect(editorEscapeStep({ ...none, stageSelection: true })).toBe("drop-layer");
  });
});

describe("isTypingTarget", () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
  it("is true for fields and contenteditable, false for buttons and nothing", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("DIV", true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
