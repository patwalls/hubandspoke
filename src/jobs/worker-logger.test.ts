import { describe, expect, it } from "vitest";
import { shouldLog, SLOW_JOB_MS } from "./worker-logger";

const job = (attempts = 1) => ({ attempts });

describe("shouldLog", () => {
  it("drops graphile's success line for a fast first-attempt job", () => {
    expect(shouldLog("info", "Completed task 1 (worker-heartbeat, 4.00ms) with success", {}, { success: true, duration: 4, job: job() })).toBe(false);
  });

  it("keeps the success line for slow jobs and retried successes", () => {
    expect(shouldLog("info", "Completed task 2 (clip-render) with success", {}, { success: true, duration: SLOW_JOB_MS, job: job() })).toBe(true);
    expect(shouldLog("info", "Completed task 3 (notion-sync) with success", {}, { success: true, duration: 20, job: job(2) })).toBe(true);
  });

  it("drops a task's own start line but keeps its result line", () => {
    const scope = { taskIdentifier: "extract-hook" };
    expect(shouldLog("info", "extract-hook start", scope, {})).toBe(false);
    expect(shouldLog("info", "extract-hook start item=abc", scope, {})).toBe(false);
    expect(shouldLog("info", "extract-hook done item=abc ok=true", scope, {})).toBe(true);
    // A different task's name is not this task's start line.
    expect(shouldLog("info", "extract-hook-sweep start", scope, {})).toBe(true);
  });

  it("always keeps errors and warnings, including failures", () => {
    expect(shouldLog("error", "Failed task 4 (x) with error 'boom'", {}, { failure: true, duration: 1 })).toBe(true);
    expect(shouldLog("warning", "slow", {}, {})).toBe(true);
  });
});
