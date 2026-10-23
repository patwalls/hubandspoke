import { describe, it, expect } from "vitest";
import { rowActionsFor, sendBackCommentHtml, withHandoff } from "./actions";

const kinds = (a: { kind: string }[]) => a.map((x) => x.kind);

describe("rowActionsFor", () => {
  it("offers Send to review only on your Assigned items", () => {
    expect(kinds(rowActionsFor("your-turn", "Assigned"))).toEqual(["send-to-review"]);
    // Ready To Publish is posted from the Publish screen, not moved from here.
    expect(rowActionsFor("your-turn", "Ready To Publish")).toEqual([]);
    expect(rowActionsFor("waiting", "Assigned")).toEqual([]);
  });

  it("offers Approve and Send back on items in Review you review", () => {
    const a = rowActionsFor("to-review", "Review");
    expect(kinds(a)).toEqual(["approve", "send-back"]);
    expect(a.map((x) => x.to)).toEqual(["Ready To Publish", "Assigned"]);
  });

  it("offers nothing on a To review row that already moved on", () => {
    expect(rowActionsFor("to-review", "Ready To Publish")).toEqual([]);
  });

  it("hides an action whose target status the brand doesn't have", () => {
    const statuses = new Set(["Idea", "Assigned", "Review", "Approved", "Published"]);
    expect(kinds(rowActionsFor("to-review", "Review", statuses))).toEqual(["send-back"]);
  });

  it("treats a brand with no configured statuses as the defaults", () => {
    expect(kinds(rowActionsFor("to-review", "Review", new Map()))).toEqual(["approve", "send-back"]);
  });
});

describe("sendBackCommentHtml", () => {
  it("is null for a blank note", () => {
    expect(sendBackCommentHtml("   ")).toBeNull();
  });

  it("escapes the note so it can't inject markup", () => {
    expect(sendBackCommentHtml(" hook <b>too</b> long & slow ")).toBe(
      "<p>Sent back: hook &lt;b&gt;too&lt;/b&gt; long &amp; slow</p>",
    );
  });
});

describe("withHandoff", () => {
  const andrew = { id: "a", name: "Andrew Gibbs" };
  const john = { id: "j", name: "John Henry Parr" };

  it("sends your Assigned row to the brand's reviewer", () => {
    const a = withHandoff(rowActionsFor("your-turn", "Assigned"), {
      kind: "send-to-review", to: "Review", person: andrew, others: [],
    });
    expect(a[0].handTo).toEqual(andrew);
  });

  it("hands both Approve and Send back to whoever sent it to review", () => {
    const a = withHandoff(rowActionsFor("to-review", "Review"), {
      kind: "approve", to: "Ready To Publish", person: john, others: [],
    });
    expect(a.map((x) => x.handTo)).toEqual([john, john]);
  });

  it("leaves the actions status-only when there's no one to hand to", () => {
    const a = withHandoff(rowActionsFor("to-review", "Review"), null);
    expect(a.every((x) => x.handTo === undefined)).toBe(true);
  });

  it("never hands a review row to the reviewer picked for send-to-review", () => {
    const a = withHandoff(rowActionsFor("to-review", "Review"), {
      kind: "send-to-review", to: "Review", person: andrew, others: [],
    });
    expect(a.every((x) => x.handTo === undefined)).toBe(true);
  });
});
