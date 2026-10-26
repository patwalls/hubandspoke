import { describe, it, expect, vi, beforeEach } from "vitest";

// HUBANDSPOKE-3D: a cross-post on a brand with no CTA offer set up threw out of
// the regenerate-cta-for-item job, so graphile retried it and Sentry paged. "No
// offer" is a setup gap, not a fault: generateTrackedCta throws a typed
// NoCtaOfferError and regenerateCtaForItem turns it into a skip with a reason.

// Each db.select()…limit() chain resolves to the next queued row list.
const rows: unknown[][] = [];
function chain(): unknown {
  const c: Record<string, unknown> = {};
  for (const k of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) c[k] = () => c;
  c.limit = async () => rows.shift() ?? [];
  return c;
}
vi.mock("@/lib/db", () => ({ db: { select: () => chain() } }));
vi.mock("@/lib/services/content-revisions", () => ({ recordContentChanges: vi.fn() }));

const resolveCtaOffer = vi.fn();
vi.mock("@/lib/services/cta-offer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/cta-offer")>();
  return { ...actual, resolveCtaOffer: (...a: unknown[]) => resolveCtaOffer(...a) };
});

import { generateTrackedCta, NoCtaOfferError } from "./tracked-cta";
import { regenerateCtaForItem } from "./regenerate-cta";

const ITEM = {
  id: "item-1",
  title: "A cross-post",
  format: null,
  brand: "my-first-million",
  postType: "x",
  utmCampaign: "a-cross-post",
  pillarContentItemId: null,
};
const DRAFT = { id: "draft-1", version: 1, content: { body: "the caption" }, fieldSchemaSnapshot: { fields: [] } };

beforeEach(() => {
  rows.length = 0;
  resolveCtaOffer.mockReset();
  resolveCtaOffer.mockResolvedValue(null);
});

describe("no CTA offer for an offer brand", () => {
  it("generateTrackedCta throws the typed NoCtaOfferError", async () => {
    rows.push([{ brand: "my-first-million" }]);
    const err = await generateTrackedCta({
      productionItemId: "item-1",
      channel: "x",
      utmCampaign: null,
      postBody: "the caption",
      pillarTitle: null,
      formatInstructions: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCtaOfferError);
  });

  it("regenerateCtaForItem (the cross-post job) skips with no_cta_offer instead of throwing", async () => {
    rows.push([ITEM], [DRAFT], [{ brand: "my-first-million" }]);
    await expect(regenerateCtaForItem({ productionItemId: "item-1", actorUserId: null })).resolves.toEqual({
      status: "skipped",
      reason: "no_cta_offer",
    });
  });

  it("still throws other CTA failures so real faults reach Sentry", async () => {
    resolveCtaOffer.mockRejectedValue(new Error("offer lookup blew up"));
    rows.push([ITEM], [DRAFT], [{ brand: "my-first-million" }]);
    await expect(regenerateCtaForItem({ productionItemId: "item-1", actorUserId: null })).rejects.toThrow(
      "offer lookup blew up",
    );
  });
});
