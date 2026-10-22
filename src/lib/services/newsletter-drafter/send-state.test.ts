import { describe, expect, it } from "vitest";
import { classifyBeehiiv, classifyHubspot } from "./send-state";

const now = new Date("2026-10-25T14:00:00Z");

describe("classifyHubspot", () => {
  it("DRAFT is a draft even when it carries a stale publishDate", () => {
    expect(classifyHubspot({ state: "DRAFT", publishDate: "2026-10-09T15:06:42Z" }, now)).toEqual({ phase: "draft", sendAt: null, link: null });
  });
  it("SCHEDULED (and the A/B kind) is scheduled for its publishDate; PROCESSING is mid-send", () => {
    expect(classifyHubspot({ state: "SCHEDULED", publishDate: "2026-10-25T13:00:00Z" }, now)).toMatchObject({ phase: "scheduled", sendAt: new Date("2026-10-25T13:00:00Z") });
    expect(classifyHubspot({ state: "SCHEDULED_AB", publishDate: "2026-10-25T13:00:00Z" }, now).phase).toBe("scheduled");
    expect(classifyHubspot({ state: "PROCESSING", publishDate: "2026-10-25T13:00:00Z" }, now).phase).toBe("sending");
  });
  it("PUBLISHED went out at its publishDate; PUBLISHED_OR_SCHEDULED depends on whether that is still ahead", () => {
    expect(classifyHubspot({ state: "PUBLISHED", publishDate: "2026-10-25T13:00:00Z" }, now)).toMatchObject({ phase: "sent", sendAt: new Date("2026-10-25T13:00:00Z") });
    expect(classifyHubspot({ state: "PUBLISHED_OR_SCHEDULED", publishDate: "2026-10-26T13:00:00Z" }, now).phase).toBe("scheduled");
    expect(classifyHubspot({ state: "PUBLISHED_OR_SCHEDULED", publishDate: "2026-10-24T13:00:00Z" }, now).phase).toBe("sent");
  });
  it("anything else is unknown, so nothing moves", () => {
    expect(classifyHubspot({ state: "AUTOMATED" }, now).phase).toBe("unknown");
    expect(classifyHubspot({}, now).phase).toBe("unknown");
  });
});

describe("classifyBeehiiv", () => {
  const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  it("draft is a draft; confirmed in the future is scheduled; confirmed in the past went out, with its page link", () => {
    expect(classifyBeehiiv({ status: "draft", publish_date: null }, now).phase).toBe("draft");
    expect(classifyBeehiiv({ status: "confirmed", publish_date: unix("2026-10-26T13:00:00Z") }, now).phase).toBe("scheduled");
    expect(classifyBeehiiv({ status: "confirmed", publish_date: unix("2026-10-25T13:00:00Z"), web_url: "https://x.beehiiv.com/p/a" }, now)).toMatchObject({
      phase: "sent",
      link: "https://x.beehiiv.com/p/a",
    });
  });
  it("archived or a confirmed post without a date is unknown", () => {
    expect(classifyBeehiiv({ status: "archived", publish_date: unix("2026-10-25T13:00:00Z") }, now).phase).toBe("unknown");
    expect(classifyBeehiiv({ status: "confirmed" }, now).phase).toBe("unknown");
  });
});
