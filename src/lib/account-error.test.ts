import { describe, it, expect } from "vitest";
import { describeAccountError } from "./account-error";

// Raw strings copied from production accounts rows (2026-10-19).
describe("describeAccountError", () => {
  it("treats personal LinkedIn profiles as unsupported, not failing", () => {
    const v = describeAccountError(
      "LinkedIn personal profiles don't support content sync — account available for routing only",
    );
    expect(v).toMatchObject({ label: "Not supported", tone: "muted" });
  });

  it("shows skipped duplicates as a warning with the count", () => {
    expect(describeAccountError("12 cross-account duplicates skipped — see logs")).toMatchObject({
      label: "12 skipped",
      tone: "warning",
    });
    expect(describeAccountError("1 cross-account duplicate skipped — see logs").hint).toBe(
      "1 post is already tracked on another account",
    );
  });

  it("prefers deactivated over the generic 404", () => {
    const v = describeAccountError(
      'SC /v3/tiktok/profile/videos 404: {"success":false,"account_deactivated":true,"handle":"x","message":"Account deactivated","error":"not_found","errorStatus":404}',
    );
    expect(v.label).toBe("Deactivated");
  });

  it("recognises missing or private accounts", () => {
    expect(
      describeAccountError(
        'SC /v1/facebook/profile/posts 404: {"success":true,"accountDoesNotExist":true,"message":"Account doesn\'t exist"}',
      ).label,
    ).toBe("Not found");
    expect(
      describeAccountError(
        'SC /v1/threads/user/posts 404: {"message":"Shoot looks like the user is not found, or is private and needs to be accessed by a logged in account :("}',
      ).label,
    ).toBe("Not found");
  });

  it("reads the status after the URL, not digits inside it", () => {
    const v = describeAccountError(
      'Klaviyo GET /campaigns?filter=greater-or-equal%28scheduled_at%2C2026-10-04T16%3A14%3A08.154Z%29 401: {"errors":[{"detail":"Incorrect authentication credentials."}]}',
    );
    expect(v.label).toBe("Auth failed");
  });

  it("parses the refresh-side '<status> <message>' shape", () => {
    expect(describeAccountError("503 upstream unavailable").label).toBe("Service error");
  });

  it("falls back to the provider message, truncated", () => {
    const v = describeAccountError(`boom: {"message":"${"x".repeat(200)}"}`);
    expect(v.label).toBe("Failed");
    expect(v.hint.length).toBe(78);
  });
});
