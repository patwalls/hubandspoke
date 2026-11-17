import { describe, it, expect } from "vitest";
import { formatCount, formatUsage, formatUsd, providerLabel } from "./ai-spend-format";

describe("formatUsd", () => {
  it("never shows a tiny cost as free", () => {
    expect(formatUsd(0.003)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0");
  });
  it("keeps cents under $1,000 and drops them above", () => {
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(1234.56)).toBe("$1,235");
  });
});

describe("formatCount", () => {
  it("compacts at each unit boundary", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1K");
    expect(formatCount(12_345)).toBe("12.3K");
    expect(formatCount(4_500_000)).toBe("4.5M");
    expect(formatCount(250_000_000)).toBe("250M");
  });
});

describe("formatUsage", () => {
  it("shows tokens, audio minutes, or a dash", () => {
    expect(formatUsage({ inputTokens: 12_000, outputTokens: 800, audioSeconds: 0 })).toBe("12K in · 800 out");
    expect(formatUsage({ inputTokens: 0, outputTokens: 0, audioSeconds: 600 })).toBe("10 audio min");
    expect(formatUsage({ inputTokens: 0, outputTokens: 0, audioSeconds: 0 })).toBe("—");
  });
});

describe("providerLabel", () => {
  it("names the two providers people know", () => {
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("other")).toBe("other");
  });
});
