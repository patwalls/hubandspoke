/**
 * The editor's "Hero cover": rebuild page 1 of a post from the hero cover
 * template (hero-cover-template.ts) — the founder cut out over a dimmed
 * backdrop, a tilted stat card behind them, the Anton headline. One Opus
 * call fills the headline, footer and the stat card from the transcript
 * (keeping the post's current headline unless told otherwise); the fill is
 * pure. The cutout itself is made in the browser (cutout-client.ts): when
 * the library already has one for the cover pick it goes straight in,
 * otherwise the slot keeps its placeholder and the editor fills it when
 * the cutout lands — the same contract as the filmstrip.
 */
import { IG_SQUARE, type DesignPage } from "@/lib/design-editor/doc";
import { buildHeroCover, HERO_COVER_TEMPLATE } from "@/lib/design-editor/hero-cover-template";
import { fillTemplate } from "@/lib/design-editor/template-fill";
import type { ImageCandidate } from "@/lib/design-editor/brand-assets";
import { generateDesignFill } from "./fill-brief";
import { previewUrlFor } from "./assets";
import { cutoutFor, type DesignPhoto } from "./photos";
import { coverPhotoFor, currentDmKeyword, designContext, DesignUnsupportedError, loadItem, loadSource, resolveImageUrls } from "./session";

export interface HeroCoverResult {
  page: DesignPage;
  /** Element id → browser URL, for the pictures on the page. */
  imageUrls: Record<string, string>;
  /** The cover photo the cutout should be made from (null while the
   *  filmstrip is still being made — the editor can retry later). */
  pick: ImageCandidate | null;
  /** The library's cutout of that photo, already on the page, or null. */
  cutout: DesignPhoto | null;
}

export async function buildHeroCoverForItem(args: {
  productionItemId: string;
  canvas: { width: number; height: number } | null;
  /** The post's current headline, kept unless the instruction changes it. */
  currentHeadline: string | null;
  instruction: string | null;
}): Promise<HeroCoverResult> {
  const item = await loadItem(args.productionItemId);
  const canvas = args.canvas ?? IG_SQUARE;
  const template = { version: 1 as const, canvas, template: HERO_COVER_TEMPLATE, pages: [buildHeroCover(canvas)] };
  const steer = [
    args.instruction?.trim() ?? "",
    args.currentHeadline?.trim()
      ? `The post's current headline is: "${args.currentHeadline.trim()}". Keep it (tightened only if it is over the room) unless the instruction above asks for a different one. The stat card must show the same number the headline leads with.`
      : "",
  ].filter(Boolean).join("\n");
  const fill = await generateDesignFill({ productionItemId: item.id, template, instruction: steer || null, dmKeyword: await currentDmKeyword(item.id) });
  if (!fill.ok) {
    if (fill.failure.reason === "no-transcript") throw new DesignUnsupportedError("no_transcript");
    throw new DesignUnsupportedError("ai_failed", fill.failure.message ?? fill.failure.reason);
  }
  const photo = await coverPhotoFor(item.sourceItemId);
  const ctx = await designContext(item.id, item.sourceItemId, photo, await loadSource(item.sourceItemId));
  const filled = fillTemplate(template, fill.fill, ctx);
  const page = filled.pages[0];
  if (!page || page.elements.length === 0) throw new DesignUnsupportedError("ai_failed", "the hero cover came back empty");
  return {
    page,
    imageUrls: await resolveImageUrls(filled),
    pick: photo ? { label: "Cover photo", src: photo, previewUrl: await previewUrlFor(photo) } : null,
    cutout: photo ? await cutoutFor(item.sourceItemId, photo) : null,
  };
}
