import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// JSX doesn't read JavaScript escapes in a quoted attribute or in text:
// placeholder="Start a thread…" shows the six characters "…" on the
// page (the Threads preview did, 2026-11-25). Write the character itself (…),
// or put a JS string in braces: placeholder={"Start a thread…"}.

const root = join(process.cwd(), "src");
const ESCAPE = String.raw`\\(?:u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|[nt])`;
// name="………"  (a quoted JSX attribute; TS assignments have a space before =)
const ATTR = new RegExp(String.raw`\b[a-zA-Z][\w-]*="[^"\n{}]*${ESCAPE}[^"\n]*"`, "g");
// >………<  (JSX text between tags)
const TEXT = new RegExp(String.raw`>[^<>{}\n"'\`]*${ESCAPE}[^<>{}\n]*<`, "g");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : tsxFiles(p);
    return e.name.endsWith(".tsx") ? [p] : [];
  });
}

function literalEscapes(source: string): string[] {
  return [...(source.match(ATTR) ?? []), ...(source.match(TEXT) ?? [])];
}

describe("JSX shows no escape sequences as text", () => {
  it("finds the shape it guards against", () => {
    expect(literalEscapes(`<X placeholder="Start a thread\\u2026" />`)).toHaveLength(1);
    expect(literalEscapes(`<p>Loading\\u2026</p>`)).toHaveLength(1);
    expect(literalEscapes(`<X placeholder={"Start a thread\\u2026"} />`)).toEqual([]);
    expect(literalEscapes(`const s = "Start\\u2026";`)).toEqual([]);
  });

  it("no .tsx file has one", () => {
    const hits = tsxFiles(root).flatMap((f) =>
      literalEscapes(readFileSync(f, "utf8")).map((m) => `${relative(root, f)}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});
