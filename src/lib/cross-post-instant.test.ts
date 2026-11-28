import { describe, it, expect } from "vitest";
import { backgroundBucket, instantOutcome } from "./cross-post-instant";

describe("instantOutcome", () => {
  it("is done when every target was created or already existed", () => {
    expect(instantOutcome({ created: 3, skipped: 1, gateFailures: 0, hardErrors: 0 })).toBe("done");
    expect(instantOutcome({ created: 0, skipped: 2, gateFailures: 0, hardErrors: 0 })).toBe("done");
  });

  it("reopens the dialog when the readiness gate refused any target, even next to creates", () => {
    // The manual-retry banner lives in the dialog; dismissing here would lose it.
    expect(instantOutcome({ created: 2, skipped: 0, gateFailures: 1, hardErrors: 0 })).toBe("reopen");
  });

  it("brings the row back when nothing was created and the requests failed", () => {
    expect(instantOutcome({ created: 0, skipped: 0, gateFailures: 0, hardErrors: 2 })).toBe("restore");
  });

  it("still finishes when some targets errored next to real creates (the old submit dismissed too)", () => {
    expect(instantOutcome({ created: 2, skipped: 0, gateFailures: 0, hardErrors: 1 })).toBe("done");
  });
});

describe("backgroundBucket", () => {
  it("buckets at 2 s and 5 s", () => {
    expect(backgroundBucket(1999)).toBe("under-2s");
    expect(backgroundBucket(2000)).toBe("2-5s");
    expect(backgroundBucket(4999)).toBe("2-5s");
    expect(backgroundBucket(5000)).toBe("5s-plus");
  });
});
