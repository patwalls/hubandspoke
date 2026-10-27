// The usual story lineup for a roundup, built from each template section's
// `story` setting (Edit template → "Story") and handed to the agent as a
// SUGGESTION. The template decides WHERE the drafter looks for each section;
// the section's instructions (`hint`) and the format Skill decide WHAT it picks
// and how it writes it. Only the no-repeat rule is enforced (agent.ts).
//
// Why: 2026-10-21's first live Sunday Breakfast ran five videos, three from
// 2025, while two case studies from that week sat unused — the agent never saw
// the week's stories side by side. Sam: a suggestion "if those stories are
// available", not a quota.
//
// Story kinds (STORY_KINDS in newsletter-template.ts):
//   newest_video  the window's newest unused videos, dealt in section order
//                 (topped up with the newest from the last 30 days)
//   recent_video  another recent video
//   case_study    the window's case studies newest first (widened to 14 days
//                 when short), else a recent video — brands with case studies only
//   any           a video or a case study, the drafter's pick
//   none / unset  no story (intro, sign-off, sponsor)
// Blocked stories (run in the last RECENT_BLOCK_DAYS) never enter the plan.

import type { NewsletterTemplate, StoryKind } from "@/lib/newsletter-template";
import { brandHasCaseStudies } from "./format-config";
import { listRecentCaseStudies, listRecentVideos } from "./sources";
import { caseStudyKey } from "./usage";
import type { DraftWindow } from "./window";

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Recent" for a fallback video: published within this many days of the window's end. */
export const RECENT_VIDEO_DAYS = 30;
/** Case studies widen to this lookback when the window has fewer than the sections need. */
export const CASE_STUDY_WIDEN_DAYS = 14;

export interface PlannedStory {
  kind: "video" | "case_study";
  key: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  productionItemId?: string;
}

export interface PlannedSection {
  sectionKey: string;
  story: StoryKind;
  /** The suggested pick, when the plan has one. */
  pick: PlannedStory | null;
}

export interface StoryPlan {
  sections: PlannedSection[];
  /** Usable case studies, newest first. */
  caseStudies: PlannedStory[];
  /** Usable recent videos, newest first (this week's first). */
  videos: PlannedStory[];
}

/** Sections with a story setting, in template order. Pure; exported for tests. */
export function storySections(template: NewsletterTemplate | null | undefined): { key: string; story: StoryKind }[] {
  return (template?.sections ?? [])
    .filter((s) => s.kind !== "sponsor" && s.story && s.story !== "none")
    .map((s) => ({ key: s.key, story: s.story! }));
}

const byNewest = (a: PlannedStory, b: PlannedStory) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

/**
 * Deal stories to sections. Pure; exported for tests. `weekVideos` = the
 * window's videos, `recentVideos` = the last RECENT_VIDEO_DAYS (may overlap).
 */
export function planStories(
  sections: { key: string; story: StoryKind }[],
  input: { weekVideos: PlannedStory[]; recentVideos: PlannedStory[]; caseStudies: PlannedStory[]; blocked?: Set<string> },
): StoryPlan {
  const ok = (s: PlannedStory) => !input.blocked?.has(s.key);
  const seen = new Set<string>();
  const uniq = (list: PlannedStory[]) =>
    list.filter((s) => {
      if (seen.has(s.key) || !ok(s)) return false;
      seen.add(s.key);
      return true;
    });
  const videos = [...uniq([...input.weekVideos].sort(byNewest)), ...uniq([...input.recentVideos].sort(byNewest))];
  const caseStudies = uniq([...input.caseStudies]).sort(byNewest);

  const used = new Set<string>();
  const next = (list: PlannedStory[]) => {
    const s = list.find((x) => !used.has(x.key)) ?? null;
    if (s) used.add(s.key);
    return s;
  };
  // Newest-video sections first, so a later "recent video" fallback can't take the week's newest.
  const picks = new Map<string, PlannedStory | null>();
  for (const s of sections) if (s.story === "newest_video") picks.set(s.key, next(videos));
  for (const s of sections) if (s.story === "case_study") picks.set(s.key, next(caseStudies) ?? next(videos));
  for (const s of sections) if (s.story === "recent_video") picks.set(s.key, next(videos));
  return {
    sections: sections.map((s) => ({ sectionKey: s.key, story: s.story, pick: picks.get(s.key) ?? null })),
    caseStudies,
    videos,
  };
}

/** Fetch the candidates for the template's story settings and plan them. Null when no section has one. */
export async function buildStoryPlan(args: {
  brand: string;
  window: DraftWindow;
  template: NewsletterTemplate | null | undefined;
  blocked?: Set<string>;
}): Promise<StoryPlan | null> {
  const sections = storySections(args.template);
  if (!sections.length) return null;
  const end = args.window.end;
  const wantsCases = brandHasCaseStudies(args.brand) && sections.some((s) => s.story === "case_study" || s.story === "any");
  const recentWindow = { start: new Date(end.getTime() - RECENT_VIDEO_DAYS * DAY_MS), end };
  const [week, recent, cases] = await Promise.all([
    listRecentVideos(args.brand, args.window),
    listRecentVideos(args.brand, recentWindow),
    wantsCases ? listRecentCaseStudies(args.window) : Promise.resolve([]),
  ]);
  const toVideo = (v: (typeof week)[number]): PlannedStory => ({
    kind: "video",
    key: `video:${v.productionItemId}`,
    title: v.title,
    url: v.url,
    publishedAt: v.publishedAt,
    productionItemId: v.productionItemId,
  });
  const toCase = (c: (typeof cases)[number]): PlannedStory | null => {
    const key = caseStudyKey(c.url);
    return key ? { kind: "case_study", key, title: c.title, url: c.url, publishedAt: c.publishedAt } : null;
  };
  let caseStudies = cases.map(toCase).filter((c): c is PlannedStory => !!c);
  const caseSlots = sections.filter((s) => s.story === "case_study").length;
  if (wantsCases && caseStudies.filter((c) => !args.blocked?.has(c.key)).length < caseSlots) {
    const wide = await listRecentCaseStudies({ start: new Date(end.getTime() - CASE_STUDY_WIDEN_DAYS * DAY_MS), end });
    caseStudies = wide.map(toCase).filter((c): c is PlannedStory => !!c);
  }
  return planStories(sections, { weekVideos: week.map(toVideo), recentVideos: recent.map(toVideo), caseStudies, blocked: args.blocked });
}

function line(s: PlannedStory): string {
  const id = s.productionItemId ? `production_item_id ${s.productionItemId}, ` : "";
  return `"${s.title ?? "Untitled"}" (${s.kind === "video" ? "video" : "case study"}, ${id}published ${s.publishedAt?.slice(0, 10) ?? "unknown"}, ${s.url ?? "no URL"})`;
}

const USUALLY: Record<StoryKind, string> = {
  newest_video: "usually the week's newest video",
  recent_video: "usually a recent video",
  case_study: "usually a case study (else a recent video)",
  any: "a video or a case study, your pick",
  none: "",
};

/** The lineup block of the agent's first turn. Pure; exported for tests. */
export function describeStoryPlan(plan: StoryPlan, hasAngle = false): string {
  const out = [
    "SUGGESTED STORY LINEUP (from the issue template: the usual shape of this newsletter when these stories are available — a starting point, not a quota; use your judgment and the section instructions, and swap in whatever makes the stronger issue, as long as the story rules hold):",
  ];
  if (hasAngle) {
    out.push(
      "These suggestions were picked by date, BEFORE anyone read THE ANGLE. Keep a suggestion only if it passes THE ANGLE's story test; otherwise replace it with a story that does, from the lists below or the tools.",
    );
  }
  for (const s of plan.sections) {
    const tail = s.pick ? ` — suggested: ${line(s.pick)}` : s.story === "any" ? "" : " — nothing recent is free; see the tools";
    out.push(`- "${s.sectionKey}": ${USUALLY[s.story]}${tail}.`);
  }
  const picked = new Set(plan.sections.map((s) => s.pick?.key).filter(Boolean));
  const extraCases = plan.caseStudies.filter((c) => !picked.has(c.key));
  const extraVideos = plan.videos.filter((v) => !picked.has(v.key));
  if (extraCases.length) out.push(`Other usable case studies, newest first:\n${extraCases.slice(0, 5).map((c) => `  - ${line(c)}`).join("\n")}`);
  if (extraVideos.length) out.push(`Other usable recent videos, newest first:\n${extraVideos.slice(0, 5).map((v) => `  - ${line(v)}`).join("\n")}`);
  out.push("Prefer these recent stories over older ones from list_older_videos. Read a case study in full with read_case_study before writing about it. Set each section's source to the story it covers.");
  return out.join("\n");
}

/** Find new story: where to look for this section's replacement, from its story setting. Pure; exported for tests. */
export function newStoryGuidance(plan: StoryPlan, sectionKey: string, exclude: Set<string>): string | null {
  const sec = plan.sections.find((s) => s.sectionKey === sectionKey);
  if (!sec) return null;
  const list = (items: PlannedStory[]) =>
    items
      .filter((s) => !exclude.has(s.key))
      .slice(0, 6)
      .map((s) => `- ${line(s)}`)
      .join("\n");
  const videos = list(plan.videos);
  const cases = list(plan.caseStudies);
  switch (sec.story) {
    case "newest_video":
    case "recent_video":
      return videos
        ? `This section usually features a video. Suggestions, newest first:\n${videos}`
        : "This section usually features a video; no recent one is free — try list_older_videos.";
    case "case_study":
      if (cases) return `This section usually features a case study. Suggestions, newest first (or a recent video if it fits better):\n${cases}`;
      return videos
        ? `No unused recent case study is left. Suggestions — a recent video that fits the issue:\n${videos}\nor search_case_studies for an older case study.`
        : "No unused recent story is left: try search_case_studies, then list_older_videos.";
    case "any":
      return (
        [cases && `Case studies:\n${cases}`, videos && `Videos:\n${videos}`].filter(Boolean).join("\n") ||
        "Nothing recent is free: try search_case_studies or list_older_videos."
      );
    default:
      return null;
  }
}

/** Stamp publish dates the plan knows onto sections' sources (case studies have no date in our DB). Pure; exported for tests. */
export function withPlanDates<T extends { source?: { key: string; publishedAt?: string | null } | null }>(sections: T[], plan: StoryPlan | null): T[] {
  if (!plan) return sections;
  const dates = new Map([...plan.caseStudies, ...plan.videos].map((s) => [s.key, s.publishedAt]));
  return sections.map((sec) =>
    sec.source && !sec.source.publishedAt && dates.get(sec.source.key) ? { ...sec, source: { ...sec.source, publishedAt: dates.get(sec.source.key) } } : sec,
  );
}
