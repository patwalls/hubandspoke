// The usual story lineup for a roundup, worked out in code and handed to the
// agent as a SUGGESTION (2026-10-21's first live Sunday Breakfast had five
// videos, three from 2025, while two case studies from that week sat unused —
// the agent never saw them side by side). Not enforced: the editor wants
// "the general shape when those stories are available", not a quota.
//
// Sunday Breakfast's usual shape (Sam 2026-10-21):
//   - lead sections (Orange Juice, Coffee) = the two newest videos published
//     that week, newest first; when the week is short, the newest recent ones
//   - flex sections (Eggs, Toast, Pancakes) = that week's case studies, newest
//     first (widened to 14 days, as the Skill says, when short); then another
//     recently published video that still fits
// Blocked stories (run in the last RECENT_BLOCK_DAYS) never enter the plan
// (the no-repeat rule itself IS enforced, in agent.ts). The plan goes into the
// agent's first turn; Find new story uses `newStoryGuidance`.

import type { StoryPlanConfig } from "./format-config";
import { listRecentCaseStudies, listRecentVideos } from "./sources";
import { caseStudyKey } from "./usage";
import type { DraftWindow } from "./window";

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Recent" for a fallback video: published within this many days of the window's end. */
export const RECENT_VIDEO_DAYS = 30;
/** Case studies widen to this lookback when the window has fewer than the flex sections need. */
export const CASE_STUDY_WIDEN_DAYS = 14;

export interface PlannedStory {
  kind: "video" | "case_study";
  key: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  productionItemId?: string;
}

export interface StoryPlan {
  lead: { sectionKey: string; story: PlannedStory | null }[];
  flexKeys: string[];
  /** Usable case studies, newest first. */
  caseStudies: PlannedStory[];
  /** Usable recent videos not given a lead section, newest first. */
  videos: PlannedStory[];
}

const byNewest = (a: PlannedStory, b: PlannedStory) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

/**
 * Assign stories to sections. Pure; exported for tests. `weekVideos` are the
 * window's videos, `recentVideos` the last RECENT_VIDEO_DAYS (may overlap).
 */
export function planStories(
  cfg: StoryPlanConfig,
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
  // This week's first (newest first), then the newest recent ones.
  const leadPool = [...uniq([...input.weekVideos].sort(byNewest)), ...uniq([...input.recentVideos].sort(byNewest))];
  const lead = cfg.leadVideos.map((sectionKey, i) => ({ sectionKey, story: leadPool[i] ?? null }));
  const caseSeen = new Set<string>();
  const caseStudies = [...input.caseStudies]
    .filter((c) => ok(c) && !caseSeen.has(c.key) && caseSeen.add(c.key))
    .sort(byNewest);
  return { lead, flexKeys: cfg.flex, caseStudies, videos: leadPool.slice(cfg.leadVideos.length) };
}

/** Fetch the candidates and plan them. One DB query per lookback + one content-API call per lookback. */
export async function buildStoryPlan(args: {
  brand: string;
  window: DraftWindow;
  cfg: StoryPlanConfig;
  blocked?: Set<string>;
}): Promise<StoryPlan> {
  const end = args.window.end;
  const recentWindow = { start: new Date(end.getTime() - RECENT_VIDEO_DAYS * DAY_MS), end };
  const [week, recent, cases] = await Promise.all([
    listRecentVideos(args.brand, args.window),
    listRecentVideos(args.brand, recentWindow),
    listRecentCaseStudies(args.window),
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
  if (caseStudies.filter((c) => !args.blocked?.has(c.key)).length < args.cfg.flex.length) {
    const wide = await listRecentCaseStudies({ start: new Date(end.getTime() - CASE_STUDY_WIDEN_DAYS * DAY_MS), end });
    caseStudies = wide.map(toCase).filter((c): c is PlannedStory => !!c);
  }
  return planStories(args.cfg, { weekVideos: week.map(toVideo), recentVideos: recent.map(toVideo), caseStudies, blocked: args.blocked });
}

function line(s: PlannedStory): string {
  const id = s.productionItemId ? `production_item_id ${s.productionItemId}, ` : "";
  return `"${s.title ?? "Untitled"}" (${id}published ${s.publishedAt?.slice(0, 10) ?? "unknown"}, ${s.url ?? "no URL"})`;
}

/** The plan block of the agent's first turn. Pure; exported for tests. */
export function describeStoryPlan(plan: StoryPlan): string {
  const out = [
    "SUGGESTED STORY LINEUP (the usual shape of this newsletter when these stories are available — a starting point, not a quota; use your judgment and swap in whatever makes the stronger issue, as long as the story rules hold):",
  ];
  for (const { sectionKey, story } of plan.lead) {
    out.push(
      story
        ? `- "${sectionKey}": usually the newest video — ${line(story)}.`
        : `- "${sectionKey}": no recent video is free — pick the best one from list_older_videos.`,
    );
  }
  const n = Math.min(plan.flexKeys.length, plan.caseStudies.length);
  const flex = plan.flexKeys.map((k) => `"${k}"`).join(", ");
  if (plan.caseStudies.length) {
    out.push(
      `- ${flex}: usually this week's case studies, newest first (web_fetch one before writing about it):\n${plan.caseStudies
        .slice(0, plan.flexKeys.length + 3)
        .map((c, i) => `  ${i + 1}. ${line(c)}`)
        .join("\n")}`,
    );
  }
  if (n < plan.flexKeys.length) {
    out.push(
      plan.videos.length
        ? `- ${n ? `Otherwise` : flex + ":"} a recently published video that still fits the issue, e.g.:\n${plan.videos
            .slice(0, 6)
            .map((v) => `  - ${line(v)}`)
            .join("\n")}`
        : `- ${n ? "Otherwise" : flex + ":"} no recent video is free — search_case_studies or list_older_videos.`,
    );
  }
  out.push("- Prefer this lineup's recent stories over older ones from list_older_videos. Set each section's source to the story it covers.");
  return out.join("\n");
}

/** Find new story: where to look for this section's replacement. Pure; exported for tests. */
export function newStoryGuidance(plan: StoryPlan, sectionKey: string, exclude: Set<string>): string | null {
  const free = (list: PlannedStory[]) => list.filter((s) => !exclude.has(s.key));
  const leadVideos = plan.lead.map((l) => l.story).filter((s): s is PlannedStory => !!s);
  if (plan.lead.some((l) => l.sectionKey === sectionKey)) {
    const videos = free([...leadVideos, ...plan.videos]);
    return videos.length
      ? `This section usually features a video: suggestions, newest first:\n${videos.slice(0, 6).map((v) => `- ${line(v)}`).join("\n")}`
      : "This section usually features a video; no recent one is free — try list_older_videos.";
  }
  if (plan.flexKeys.includes(sectionKey)) {
    const cases = free(plan.caseStudies);
    const videos = free(plan.videos);
    if (cases.length) return `This section usually features a case study when one is available: suggestions, newest first (web_fetch it before writing), or a recent video if it fits better:\n${cases.slice(0, 6).map((c) => `- ${line(c)}`).join("\n")}`;
    return videos.length
      ? `No unused recent case study is left: suggestions are a recently published video that fits the issue:\n${videos.slice(0, 6).map((v) => `- ${line(v)}`).join("\n")}\nor search_case_studies for an older case study.`
      : "No unused recent story is left: try search_case_studies, then list_older_videos.";
  }
  return null;
}

/** Stamp publish dates the plan knows onto sections' sources (case studies have no date in our DB). Pure; exported for tests. */
export function withPlanDates<T extends { source?: { key: string; publishedAt?: string | null } | null }>(sections: T[], plan: StoryPlan | null): T[] {
  if (!plan) return sections;
  const dates = new Map(
    [...plan.lead.map((l) => l.story).filter((s): s is PlannedStory => !!s), ...plan.caseStudies, ...plan.videos].map((s) => [s.key, s.publishedAt]),
  );
  return sections.map((sec) =>
    sec.source && !sec.source.publishedAt && dates.get(sec.source.key) ? { ...sec, source: { ...sec.source, publishedAt: dates.get(sec.source.key) } } : sec,
  );
}
