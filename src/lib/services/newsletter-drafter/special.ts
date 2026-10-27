// The ad in a newsletter draft (the template's sponsor section: The Special,
// Free Resource). Every way the side panel changes it lands here: paste copy
// from Slack / a doc / an email (as written or written in our voice), "Make
// changes" with an instruction, swap the main link, take the ad out of the
// issue, or re-pull it from the Asana promo calendar.
//
// Every write bumps the draft's revision. The editor re-seeds its local copy
// only when the revision moves, so without the bump its autosave would write
// the old copy straight back over a rewrite (the bug this file was split out
// to fix, 2026-10-27).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts } from "@/lib/db/schema";
import { findSpecial as findSpecialDefault } from "./promo";
import { formatConfigFor } from "./format-config";
import { getPastIssues } from "./sources";
import { rewriteSpecial as rewriteSpecialDefault } from "./special-rewrite";
import { composeSpecialBlock, withAdLink } from "./special-compose";
import { templateFor, type NewsletterSection } from "@/lib/newsletter-template";

export type SpecialAction =
  /** Restore the copy exactly as it came in (Asana, or what was pasted). */
  | { action: "verbatim" }
  /** Re-pull the promo task for the send date from Asana. */
  | { action: "refresh" }
  /** Write it in our voice; with `instruction`, "Make changes" to the ad as it is now (`current`). */
  | { action: "rewrite"; instruction?: string | null; current?: string | null }
  /** New ad copy pasted in (plus its link), used as written or written in our voice. */
  | { action: "paste"; copy: string; link?: string | null; rewrite?: boolean }
  /** Swap the ad's main link (`current` = the ad as it shows now). */
  | { action: "link"; url: string; current: string }
  /** Take the ad out of this issue (the email drops the section and its heading). */
  | { action: "remove" };

export type SpecialResult = { ok: true } | { ok: false; status: number; error: string };

export interface SpecialDeps {
  findSpecial?: typeof findSpecialDefault;
  rewriteSpecial?: typeof rewriteSpecialDefault;
}

export async function applySpecialAction(id: string, input: SpecialAction, deps: SpecialDeps = {}): Promise<SpecialResult> {
  const findSpecial = deps.findSpecial ?? findSpecialDefault;
  const rewriteSpecial = deps.rewriteSpecial ?? rewriteSpecialDefault;
  const [row] = await db
    .select({
      brand: newsletterDrafts.brand,
      sendDate: newsletterDrafts.sendDate,
      sections: newsletterDrafts.sections,
      specialCopy: newsletterDrafts.specialCopy,
      specialOriginal: newsletterDrafts.specialOriginal,
      specialSource: newsletterDrafts.specialSource,
      formatName: formats.name,
      formatInstructions: formats.instructions,
      formatTemplate: formats.newsletterTemplate,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: "Not found" };

  const save = async (patch: Partial<typeof newsletterDrafts.$inferInsert>): Promise<SpecialResult> => {
    await db
      .update(newsletterDrafts)
      .set({ ...patch, revision: sql`${newsletterDrafts.revision} + 1`, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, id));
    return { ok: true };
  };
  const rewrite = async (sponsorCopy: string, landingUrl: string | null, instruction?: string | null) =>
    rewriteSpecial({
      formatName: row.formatName,
      label: formatConfigFor(row.formatName).promo?.label ?? "sponsored section",
      formatInstructions: row.formatInstructions,
      sponsorCopy,
      landingUrl,
      instruction,
      pastIssues: await getPastIssues(row.brand, row.formatName),
    });
  const sponsorKey = templateFor(row.formatName, row.formatTemplate)?.sections.find((s) => s.kind === "sponsor")?.key ?? null;
  // What the drafter wrote in the ad's slot (shown when there's no ad copy).
  const written = sponsorKey ? ((row.sections as NewsletterSection[]).find((s) => s.key === sponsorKey)?.markdown ?? "").trim() : "";

  switch (input.action) {
    case "refresh": {
      const special = await findSpecial(row.formatName, row.sendDate);
      if (!special) return { ok: false, status: 422, error: "This newsletter has no promo calendar in Asana" };
      if (!special.ok) return save({ specialError: special.error });
      return save({ specialOriginal: special.copy, specialCopy: special.copy, specialMode: "verbatim", specialSource: special.source, specialError: null });
    }
    case "verbatim": {
      if (!row.specialOriginal) return { ok: false, status: 409, error: "No original ad copy on this draft" };
      return save({ specialCopy: row.specialOriginal, specialMode: "verbatim" });
    }
    case "paste": {
      const copy = input.copy.trim();
      if (!copy) return { ok: false, status: 400, error: "Paste the ad copy first" };
      const link = input.link?.trim() || null;
      // Pasted copy isn't the Asana task's: drop that source (its landing page would add a second CTA).
      const pasted = { specialOriginal: composeSpecialBlock(copy, link), specialSource: null, specialError: null };
      if (!input.rewrite) return save({ ...pasted, specialCopy: pasted.specialOriginal, specialMode: "verbatim" });
      const result = await rewrite(copy, link);
      if (!result.ok) return { ok: false, status: 502, error: `Couldn't write the ad: ${result.failure}` };
      return save({ ...pasted, specialCopy: result.copy, specialMode: "rewrite" });
    }
    case "rewrite": {
      const current = input.current?.trim() || row.specialCopy?.trim() || written;
      // "Make changes" works on the ad as it is now; a plain rewrite starts from the original copy.
      const base = input.instruction?.trim() ? current : row.specialOriginal?.trim() || current;
      if (!base) return { ok: false, status: 409, error: "No ad copy to rewrite: paste it in first" };
      const result = await rewrite(base, row.specialSource?.landingUrl ?? null, input.instruction);
      if (!result.ok) return { ok: false, status: 502, error: `Rewrite failed: ${result.failure}` };
      // The drafter's copy becomes the original the first time it's rewritten, so "Use as written" can bring it back.
      return save({ specialCopy: result.copy, specialMode: "rewrite", ...(row.specialOriginal ? {} : { specialOriginal: base }) });
    }
    case "link": {
      const url = input.url.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, status: 400, error: "That link needs to start with https://" };
      const current = input.current.trim() || row.specialCopy?.trim() || written;
      if (!current) return { ok: false, status: 409, error: "No ad copy yet: paste it in first" };
      return save({
        specialCopy: withAdLink(current, url),
        ...(row.specialOriginal ? { specialOriginal: withAdLink(composeSpecialBlock(row.specialOriginal, row.specialSource?.landingUrl ?? null), url) } : {}),
        ...(row.specialSource ? { specialSource: { ...row.specialSource, landingUrl: url } } : {}),
      });
    }
    case "remove": {
      // Keep what was there as the original, so "Put it back" restores it.
      const keep = row.specialOriginal?.trim() || row.specialCopy?.trim() || written || null;
      const sections = sponsorKey ? (row.sections as NewsletterSection[]).map((s) => (s.key === sponsorKey ? { ...s, markdown: "" } : s)) : row.sections;
      return save({ specialCopy: null, specialOriginal: keep, specialMode: "removed", sections });
    }
  }
}
