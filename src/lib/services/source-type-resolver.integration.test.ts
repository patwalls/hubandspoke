/**
 * Integration tests for `resolveSourceTypeForFormat`. Hits the real local
 * Postgres because the resolver's whole job is to look up
 * `formats.labels_as_original`. Uses the shared `src/test/factories.ts`
 * helpers so cleanup is automatic.
 *
 * Why this exists: the resolver replaces the YT-long-form heuristic that
 * the 2026-05-11 consolidation backfill used. Any sourceType-assigning
 * write site (POST /api/production-items, /duplicate, notion-sync) defers
 * to this helper — getting it wrong silently mis-classifies every new
 * row. Cheap test, big blast radius.
 */
import { describe, it, expect } from "vitest";
import { resolveSourceTypeForFormat } from "./source-type-resolver";
import { createTestFormat } from "@/test/factories";

describe("resolveSourceTypeForFormat", () => {
  it("returns 'original' when the format is flagged labels_as_original=true", async () => {
    const fmt = await createTestFormat({ labelsAsOriginal: true });
    const result = await resolveSourceTypeForFormat(fmt.brand, fmt.name);
    expect(result).toBe("original");
  });

  it("returns 'repurposed' when the format is flagged labels_as_original=false", async () => {
    const fmt = await createTestFormat({ labelsAsOriginal: false });
    const result = await resolveSourceTypeForFormat(fmt.brand, fmt.name);
    expect(result).toBe("repurposed");
  });

  it("returns 'repurposed' when the format doesn't exist (defensive default)", async () => {
    const result = await resolveSourceTypeForFormat(
      "starter-story",
      "format-that-does-not-exist-vitest",
    );
    expect(result).toBe("repurposed");
  });

  it("returns 'repurposed' when format is null/undefined (no format = derivative)", async () => {
    expect(await resolveSourceTypeForFormat("starter-story", null)).toBe(
      "repurposed",
    );
    expect(await resolveSourceTypeForFormat("starter-story", undefined)).toBe(
      "repurposed",
    );
    expect(await resolveSourceTypeForFormat("starter-story", "")).toBe(
      "repurposed",
    );
  });

  it("scopes the lookup by brand — same name in a different brand doesn't leak", async () => {
    const a = await createTestFormat({
      brand: "starter-story",
      labelsAsOriginal: true,
    });
    // Same name, different brand, opposite flag. Looking up by starter-story
    // must NOT match the matg row.
    await createTestFormat({
      brand: "matg",
      name: a.name,
      labelsAsOriginal: false,
    });
    expect(await resolveSourceTypeForFormat("starter-story", a.name)).toBe(
      "original",
    );
    expect(await resolveSourceTypeForFormat("matg", a.name)).toBe("repurposed");
  });

  it("matches format name case-insensitively (mirrors the formats table's unique index)", async () => {
    const fmt = await createTestFormat({
      name: `vitest-PILLAR-${Date.now().toString(36)}`,
      labelsAsOriginal: true,
    });
    // Caller passed lowercase; the formats row is mixed case. Should still match.
    const result = await resolveSourceTypeForFormat(
      fmt.brand,
      fmt.name.toLowerCase(),
    );
    expect(result).toBe("original");
  });
});
