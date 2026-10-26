import { describe, expect, it } from "vitest";
import { PUSH_STALE_MS, pushView, stalePush } from "./push-state";

describe("a push to HubSpot / beehiiv that never finished", () => {
  const now = new Date("2026-10-26T12:00:00Z").getTime();
  const ago = (ms: number) => new Date(now - ms);

  it("is stale once it has been pending longer than any push can take (the worker died mid-push)", () => {
    expect(stalePush("pending", ago(PUSH_STALE_MS + 1000), now)).toBe(true);
    expect(stalePush("pending", ago(60_000), now)).toBe(false);
    expect(stalePush("created", ago(PUSH_STALE_MS * 10), now)).toBe(false);
    expect(stalePush(null, ago(PUSH_STALE_MS * 10), now)).toBe(false);
  });

  it("shows a stale push as failed with a way forward, so the button comes back instead of spinning forever", () => {
    const v = pushView("pending", null, ago(PUSH_STALE_MS * 2), now, "HubSpot");
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/didn't finish/);
    expect(v.error).toMatch(/HubSpot/);
    expect(pushView("pending", null, ago(1000), now, "HubSpot")).toEqual({ status: "pending", error: null });
    expect(pushView("failed", "boom", ago(1000), now, "HubSpot")).toEqual({ status: "failed", error: "boom" });
  });
});
