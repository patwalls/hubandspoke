// Worker-only: find the "lines to stitch in" for one clip section that
// predates section-picker v2 (clip stitching M3). Enqueued when the clip
// editor opens an idea on such a section; one Haiku call (~5–15 s), result
// stored on clip_sections.supporting_moments, which the editor polls.
// Idempotent: a section that already has moments (or [] = none) is skipped.
import type { Task } from "graphile-worker";
import { suggestStitchForSection } from "@/lib/services/clip-stitch-suggest";

export interface ClipSectionStitchPayload {
  clipSectionId: string;
}

export const clipSectionStitchTask: Task = async (rawPayload, helpers) => {
  const { clipSectionId } = rawPayload as ClipSectionStitchPayload;
  const outcome = await suggestStitchForSection(clipSectionId, (m) => helpers.logger.info(m));
  if (outcome.status === "skip") {
    helpers.logger.info(`clip-section-stitch skip section=${clipSectionId} reason=${outcome.reason}`);
  }
};
