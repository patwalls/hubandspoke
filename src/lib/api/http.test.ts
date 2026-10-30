import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, decodeCursor, encodeCursor, idFromPath, parseQuery, requireUuid, zBool } from "./http";

const ID = "7a9c1e9e-5b1c-4b61-9d4f-2f0a1a0c5d21";

describe("cursors", () => {
  it("round-trips", () => {
    const c = { t: "2026-10-21T15:00:00.000Z", id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("null/empty means first page", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
  it("garbage is a 400, not a crash or a silent first page", () => {
    for (const bad of ["abc", Buffer.from('{"t":"x","id":"y"}').toString("base64url"), Buffer.from("[]").toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrowError(ApiError);
      try {
        decodeCursor(bad);
      } catch (e) {
        expect((e as ApiError).status).toBe(400);
      }
    }
  });
});

describe("parseQuery", () => {
  const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), flag: zBool.optional() });
  it("coerces and defaults", () => {
    expect(parseQuery(new URL("http://x/?flag=1"), schema)).toEqual({ limit: 25, flag: true });
    expect(parseQuery(new URL("http://x/?limit=5&flag=false"), schema)).toEqual({ limit: 5, flag: false });
  });
  it("names the offending param in a 400", () => {
    try {
      parseQuery(new URL("http://x/?limit=500"), schema);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ApiError;
      expect(err.type).toBe("invalid_request");
      expect(JSON.stringify(err.details)).toContain('"param":"limit"');
    }
  });
});

describe("ids", () => {
  it("accepts a UUID in any case and lowercases it", () => {
    expect(requireUuid(ID.toUpperCase())).toBe(ID);
  });
  it("rejects non-UUIDs with a 400", () => {
    expect(() => requireUuid("123")).toThrowError(ApiError);
  });
  it("pulls the id out of nested paths", () => {
    expect(idFromPath(new URL(`http://x/api/v1/content/${ID}/transcript`), "content")).toBe(ID);
    expect(() => idFromPath(new URL("http://x/api/v1/content/nope/transcript"), "content")).toThrowError(ApiError);
  });
});
