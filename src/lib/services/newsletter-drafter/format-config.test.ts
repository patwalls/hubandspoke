import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { describe, expect, it } from "vitest";
import { buildUserTurn, type NewsletterAgentArgs } from "./agent";
import { formatConfigFor, voiceForChannel } from "./format-config";
import { SPECIAL_MARKER } from "./special-compose";
import { youtubeThumbnailUrl } from "./sources";

const base: NewsletterAgentArgs = {
  brand: "futurepedia",
  brandLabel: "Futurepedia",
  brandGuidelines: null,
  formatName: "How-To Newsletter - Futurepedia (pilot)",
  formatInstructions: null,
  pastIssues: [],
  window: { start: new Date("2026-10-13T00:00:00Z"), end: new Date("2026-10-20T00:00:00Z") },
  sendDate: "2026-10-21",
};
const video = {
  productionItemId: "v1",
  title: "NotebookLM just got scary good",
  url: "https://www.youtube.com/watch?v=abc123",
  thumbnailUrl: "https://img.youtube.com/vi/abc123/maxresdefault.jpg",
  publishedAt: "2026-10-19T15:00:00.000Z",
  transcript: "Today I'm showing you three NotebookLM features…",
  truncated: false,
};

describe("formatConfigFor", () => {
  it("Futurepedia Newsletter is one single-video format fed by both channels, voice by channel, queued per video", () => {
    const fp = formatConfigFor(" Futurepedia Newsletter ");
    // No model pin: it drafts on the default (Opus 5.5).
    expect(fp.model).toBeUndefined();
    expect(fp).toMatchObject({ kind: "single_video", schedule: { group: "futurepedia-howto", trigger: { kind: "queue", maxPerWeek: 7 } } });
    expect(fp.promo).toMatchObject({ label: "Free Resource", onMiss: "placeholder", section: "Native Ad" });
    expect(voiceForChannel("Futurepedia Newsletter", "futurepedia_io")).toEqual({ voice: "kevin", voiceName: "Kevin" });
    expect(voiceForChannel("Futurepedia Newsletter", "skillleapai")).toEqual({ voice: "saj", voiceName: "Saj" });
    expect(voiceForChannel("Futurepedia Newsletter", "Howfinity")).toBeNull();
  });

  it("keeps Sunday Breakfast a roundup whose Special falls back to the agent, and defaults others to plain roundups", () => {
    expect(formatConfigFor("Sunday Breakfast")).toMatchObject({ kind: "roundup", promo: { label: "The Special", onMiss: "agent" } });
    expect(formatConfigFor("Daily Seinfeld")).toMatchObject({ kind: "roundup" });
    expect(formatConfigFor("Daily Seinfeld").promo).toBeUndefined();
    expect(formatConfigFor("Playbook")).toEqual({ kind: "roundup" });
  });
});

describe("buildUserTurn", () => {
  it("hands a single-video issue its transcript, video link and thumbnail instead of a search window", () => {
    const turn = buildUserTurn({ ...base, video });
    expect(turn).toContain(video.transcript);
    expect(turn).toContain(video.url);
    expect(turn).toContain(video.thumbnailUrl);
    expect(turn).not.toContain("default window");
  });

  it("leaves the marker for a booked sponsor and points other offer mentions at its landing page", () => {
    const turn = buildUserTurn({ ...base, video, specialLabel: "Free Resource", sponsoredCopy: "Grab the guide", sponsoredLandingUrl: "https://lp.example/x" });
    expect(turn).toContain(SPECIAL_MARKER);
    expect(turn).toContain('"Free Resource"');
    expect(turn).toContain("https://lp.example/x");
  });

  it("asks for a fully marked placeholder when no sponsor is booked and the format wants one", () => {
    const turn = buildUserTurn({ ...base, video, specialLabel: "Free Resource", sponsoredPlaceholder: true });
    expect(turn).toContain("[PLACEHOLDER:");
    expect(turn).not.toContain(SPECIAL_MARKER);
  });

  it("makes the editor's angle the brief: ahead of the template and the story plan, and restated at the end", () => {
    const angle = "how I can't stop thinking about this business, then why (automated marketing and SEO)";
    const turn = buildUserTurn({
      ...base,
      pillar: video,
      notes: angle,
      template: DEFAULT_TEMPLATES["sunday breakfast"],
    });
    const at = turn.indexOf("THE ANGLE");
    expect(at).toBeGreaterThan(turn.indexOf(video.transcript));
    expect(at).toBeLessThan(turn.indexOf("ISSUE TEMPLATE"));
    expect(turn.slice(at)).toContain(angle);
    expect(turn.trimEnd().endsWith("nothing in the issue may wander off it.")).toBe(true);
    expect(buildUserTurn({ ...base, video })).not.toContain("THE ANGLE");
  });
});

describe("youtubeThumbnailUrl", () => {
  it("builds the maxres thumbnail URL, or null without an id", () => {
    expect(youtubeThumbnailUrl("abc123")).toBe("https://img.youtube.com/vi/abc123/maxresdefault.jpg");
    expect(youtubeThumbnailUrl(null)).toBeNull();
  });
});
