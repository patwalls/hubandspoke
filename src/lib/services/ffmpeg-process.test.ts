import { describe, it, expect } from "vitest";
import { runWatchedProcess } from "./ffmpeg-process";

// Uses /bin/sh instead of ffmpeg so the watchdogs are tested, not the codec.

describe("runWatchedProcess watchdogs", () => {
  it("resolves on exit 0 and feeds progress lines to onProgress", async () => {
    const seen: number[] = [];
    await runWatchedProcess("/bin/sh", ["-c", "printf 'out_time_ms=1500000\\n'"], {
      onProgress: (s) => seen.push(s),
      stallTimeoutMs: 5_000,
    });
    expect(seen).toEqual([1.5]);
  });

  it("kills a silent process once the stall timeout passes", async () => {
    const t0 = Date.now();
    await expect(
      runWatchedProcess("/bin/sh", ["-c", "sleep 30"], { stallTimeoutMs: 300, maxRuntimeMs: 0 }),
    ).rejects.toThrow(/killed \(stalled: no output for 0s\)/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("does not count a chatty process as stalled, but the hard cap still ends it", async () => {
    await expect(
      runWatchedProcess(
        "/bin/sh",
        ["-c", "while true; do echo tick >&2; sleep 0.05; done"],
        { stallTimeoutMs: 400, maxRuntimeMs: 700 },
      ),
    ).rejects.toThrow(/exceeded max runtime/);
  });

  it("kills the process when the abort signal fires and says why", async () => {
    const ac = new AbortController();
    const p = runWatchedProcess("/bin/sh", ["-c", "sleep 30"], {
      stallTimeoutMs: 0,
      maxRuntimeMs: 0,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(new Error("deploy in progress")), 100);
    await expect(p).rejects.toThrow(/aborted: deploy in progress/);
  });

  it("reports a non-zero exit with the stderr tail", async () => {
    await expect(
      runWatchedProcess("/bin/sh", ["-c", "echo boom >&2; exit 3"], { stallTimeoutMs: 0, maxRuntimeMs: 0 }),
    ).rejects.toThrow(/exited 3: boom/);
  });
});
