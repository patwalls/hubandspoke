import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { isAcademyEditor } from "./editors";

const as = (email: string | null) => ({ user: { email } }) as unknown as Session;

describe("isAcademyEditor", () => {
  it("allows only Sam, Pat and Evgeny (case-insensitive)", () => {
    expect(isAcademyEditor(as("sam@starterstory.com"))).toBe(true);
    expect(isAcademyEditor(as("PatrickSWalls@gmail.com"))).toBe(true);
    expect(isAcademyEditor(as("timjohn2002@gmail.com"))).toBe(true);
  });

  it("refuses everyone else, including other admins and missing sessions", () => {
    expect(isAcademyEditor(as("pwalls@starterstory.com"))).toBe(false);
    expect(isAcademyEditor(as("someone@example.com"))).toBe(false);
    expect(isAcademyEditor(as(null))).toBe(false);
    expect(isAcademyEditor(null)).toBe(false);
  });
});
