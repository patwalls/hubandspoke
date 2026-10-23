import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `next build` must not need the internet beyond npm. `next/font/google`
// downloads every font file from fonts.gstatic.com during the build, and one
// failed fetch fails the whole Heroku deploy (build d9e2de84, 2026-10-23:
// "Can't resolve '@vercel/turbopack-next/internal/font/google/font'" ×60).
// Fonts come from the @fontsource packages instead — see src/app/layout.tsx.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(tsx?|jsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe("build has no network dependency", () => {
  it("nothing imports next/font/google", () => {
    const offenders = sourceFiles(join(process.cwd(), "src")).filter((f) =>
      /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
