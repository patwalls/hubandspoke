/**
 * The rule that sends a format's posts on X to the in-app clip editor.
 * Pure — the data comes from `clipPostRoutingFor` (services/clip-editor/
 * from-candidate.ts). Two signals, either one enough:
 *   - the Skill cuts a clip from the video (Haiku's saved read of it —
 *     services/clip-editor/skill-clip-check.ts), so a brand-new format works
 *     from its first post;
 *   - the format's published X posts usually carry a video, which catches a
 *     Skill that never says so.
 * A Skill that posts the WHOLE video stays classic either way, and a format
 * with a design template (an image / carousel post on X, e.g. a TMZ-style
 * post) always opens the design editor — the template outranks both signals.
 */

/** A format "posts with video" when at least this share of its last
 *  year's published posts carried one… */
export const VIDEO_SHARE = 0.5;
/** …out of at least this many. */
export const MIN_PUBLISHED = 3;

export interface ClipPostRoute {
  editor: "clip" | "design" | "classic";
  /** One plain sentence for the format page. */
  because: string;
}

export function routeFormat(args: {
  check: { verdict: "clip" | "whole_video" | "none"; reason: string } | null;
  published: number;
  withVideo: number;
  /** Stored design template or a built-in preset (formatsWithDesignTemplate). */
  hasDesignTemplate?: boolean;
}): ClipPostRoute {
  const { check, published, withVideo } = args;
  if (args.hasDesignTemplate) return { editor: "design", because: "It has a design template." };
  const history = `${withVideo} of its ${published} published post${published === 1 ? "" : "s"} on X this year carried a video`;
  if (check?.verdict === "whole_video") {
    return { editor: "classic", because: `${check.reason || "The Skill posts the whole video."} Whole videos stay in the classic view.` };
  }
  if (check?.verdict === "clip") return { editor: "clip", because: check.reason || "The Skill cuts a clip from the video." };
  if (published >= MIN_PUBLISHED && withVideo / published >= VIDEO_SHARE) {
    return { editor: "clip", because: `${history}.` };
  }
  return {
    editor: "classic",
    because: check
      ? `The Skill doesn't cut a clip from the video, and ${history}.`
      : `${history}, and the Skill couldn't be read just now.`,
  };
}
