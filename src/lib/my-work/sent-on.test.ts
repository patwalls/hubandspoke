import { describe, it, expect } from "vitest";
import { sentOnLine } from "./sent-on";

describe("sentOnLine", () => {
  it("names a kill as a kill, not a hand-off", () => {
    expect(sentOnLine({ status: "Killed", prevStatus: "Assigned", editorChanged: false })).toBe("Killed.");
  });

  it("says Published after a publish", () => {
    expect(sentOnLine({ status: "Published", prevStatus: "Ready To Publish", editorChanged: false })).toBe(
      "Published.",
    );
  });

  it("a status move to Review says sent to review", () => {
    expect(sentOnLine({ status: "Review", prevStatus: "Assigned", editorChanged: false })).toBe("Sent to review.");
    expect(sentOnLine({ status: "Review", prevStatus: "Assigned", editorChanged: true })).toBe(
      "Handed on for review.",
    );
  });

  it("Review → Ready To Publish is an approval; any other way in is not", () => {
    expect(sentOnLine({ status: "Ready To Publish", prevStatus: "Review", editorChanged: true })).toBe("Approved.");
    expect(sentOnLine({ status: "Ready To Publish", prevStatus: "Assigned", editorChanged: false })).toBe(
      "Ready to publish.",
    );
  });

  it("only the editor changed: handed on", () => {
    expect(sentOnLine({ status: "Assigned", prevStatus: "Assigned", editorChanged: true })).toBe("Handed on.");
  });

  it("no status or editor change it can see: neutral words", () => {
    expect(sentOnLine({ status: "Assigned", prevStatus: "Assigned", editorChanged: false })).toBe("Off your plate.");
  });

  it("any other status is named", () => {
    expect(sentOnLine({ status: "Idea", prevStatus: "Assigned", editorChanged: false })).toBe("Moved to Idea.");
  });
});
