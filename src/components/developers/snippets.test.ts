import { describe, expect, it } from "vitest";
import { claudeCodeSnippet, claudeDesktopSnippet, cursorSnippet, curlSnippet, KEY_PLACEHOLDER, sheetsSnippet } from "./snippets";

describe("developer snippets", () => {
  const base = "https://hs.example.com";
  it("use the placeholder until a key exists, then the real key", () => {
    expect(curlSnippet(base)).toContain(`Bearer ${KEY_PLACEHOLDER}`);
    expect(curlSnippet(base, "hs_live_abc")).toContain("Bearer hs_live_abc");
    expect(curlSnippet(base, "hs_live_abc")).not.toContain(KEY_PLACEHOLDER);
  });
  it("MCP configs are valid JSON pointing at /api/v1/mcp", () => {
    for (const s of [cursorSnippet(base, "k"), claudeDesktopSnippet(base, "k")]) {
      const parsed = JSON.parse(s) as { mcpServers: { hubandspoke: Record<string, unknown> } };
      expect(JSON.stringify(parsed)).toContain(`${base}/api/v1/mcp`);
      expect(JSON.stringify(parsed)).toContain("Bearer k");
    }
    expect(claudeCodeSnippet(base, "k")).toContain("--transport http");
  });
  it("the Sheets function returns a header row before data", () => {
    expect(sheetsSnippet(base)).toContain('[["Title", "Type", "Status", "Published", "Views", "Link"]]');
  });
});
