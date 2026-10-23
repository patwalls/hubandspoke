/**
 * The production_items row for one generated clip idea. Pure, so the rules
 * are tested.
 *
 * Ideas start unassigned (editorUserId null) — not the person who clicked
 * Generate, not the pillar's owner. An idea is backlog until someone picks
 * it up; before 2026-10-23 every idea took an owner, which put 2,242 Ideas in
 * Pat's name and 432 in Sam's.
 */
export function clipIdeaItemValues(args: {
  hook: string;
  body: string;
  brand: string;
  formatName: string;
  pillarId: string;
  clipIdeaId: string;
  platform: string[] | null;
  postType: string;
  accountId: string | null;
  utmCampaign: string;
}) {
  return {
    title: args.hook,
    status: "Idea",
    platform: args.platform,
    postType: args.postType,
    accountId: args.accountId,
    format: args.formatName,
    brand: args.brand,
    contentBody: args.body,
    pillarContentItemId: args.pillarId,
    sourceType: "repurposed",
    sourceClipIdeaId: args.clipIdeaId,
    editorUserId: null,
    utmCampaign: args.utmCampaign,
    hook: args.hook,
    hookSource: "clip_idea",
    hookExtractedAt: new Date(),
    createdVia: "service:clip-idea-generate",
  };
}
