import { describe, it, expect } from "vitest";
import { matchZernioAccount, connectNotice } from "./connect-match";

const hustle = { _id: "z-hustle", platform: "tiktok", username: "thehustle.co" };
const skill = { _id: "z-skill", platform: "tiktok", username: "skill.leap" };

describe("matchZernioAccount", () => {
  it("finds the new account by handle when two are on the profile and no id is echoed (Skill Leap, 2026-11-07)", () => {
    expect(
      matchZernioAccount({
        handle: "skill.leap",
        echoedAccountId: null,
        echoedUsername: null,
        accounts: [hustle, skill],
      }),
    ).toEqual({ ok: true, zernioAccountId: "z-skill" });
  });

  it("refuses to bind a different TikTok login to this account (Starter Story → The Hustle, 2026-06)", () => {
    expect(
      matchZernioAccount({
        handle: "starterstory",
        echoedAccountId: "z-hustle",
        echoedUsername: "thehustle.co",
        accounts: [hustle],
      }),
    ).toEqual({ ok: false, status: "wrong_account", connectedAs: "thehustle.co" });
  });

  it("ignores case and a leading @ on either side", () => {
    expect(
      matchZernioAccount({
        handle: "@Skill.Leap",
        echoedAccountId: null,
        echoedUsername: null,
        accounts: [{ ...skill, username: "@skill.leap" }],
      }),
    ).toEqual({ ok: true, zernioAccountId: "z-skill" });
  });

  it("reports no_account when nothing matches and Zernio said nothing", () => {
    expect(
      matchZernioAccount({
        handle: "howfinity",
        echoedAccountId: null,
        echoedUsername: null,
        accounts: [hustle],
      }),
    ).toEqual({ ok: false, status: "no_account" });
  });
});

describe("connectNotice", () => {
  it("names the wrong login so the user knows what to switch", () => {
    expect(connectNotice("wrong_account", "starterstory", "thehustle.co")?.text).toContain(
      "@thehustle.co, not @starterstory",
    );
  });
  it("is silent with no status", () => {
    expect(connectNotice(null)).toBeNull();
  });
});
