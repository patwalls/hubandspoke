import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { addRemoval } from "@/lib/clip-editor/removals";
import { clearBackup, takeBackup, writeBackup } from "./local-backup";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

const server = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" });
const edited = () => {
  const d = server();
  d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 103 }, "manual");
  return d;
};

describe("local backup", () => {
  it("recovers edits made on top of the revision the server still has", () => {
    writeBackup("idea", 4, edited());
    expect(takeBackup("idea", 4, server())).toEqual(edited());
  });

  it("the server wins when it has moved on — and the stale backup is dropped", () => {
    writeBackup("idea", 4, edited());
    expect(takeBackup("idea", 5, server())).toBeNull();
    expect(store.size).toBe(0);
  });

  it("ignores a backup identical to what the server already has", () => {
    writeBackup("idea", 4, server());
    expect(takeBackup("idea", 4, server())).toBeNull();
    expect(store.size).toBe(0);
  });

  it("drops a corrupt or schema-invalid backup instead of opening the editor on it", () => {
    store.set("hs:clip-editor:backup:idea", "{not json");
    expect(takeBackup("idea", 4, server())).toBeNull();
    store.set("hs:clip-editor:backup:idea", JSON.stringify({ baseRevision: 4, doc: { version: 99 }, at: 1 }));
    expect(takeBackup("idea", 4, server())).toBeNull();
    expect(store.size).toBe(0);
  });

  it("is per idea, and clearBackup removes only that idea's", () => {
    writeBackup("a", 1, edited());
    writeBackup("b", 1, edited());
    clearBackup("a");
    expect(takeBackup("a", 1, server())).toBeNull();
    expect(takeBackup("b", 1, server())).not.toBeNull();
  });

  it("never throws when storage is unavailable (private mode / quota)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("quota"); },
        removeItem: () => { throw new Error("denied"); },
      },
    });
    expect(() => writeBackup("idea", 1, edited())).not.toThrow();
    expect(takeBackup("idea", 1, server())).toBeNull();
    expect(() => clearBackup("idea")).not.toThrow();
  });
});
