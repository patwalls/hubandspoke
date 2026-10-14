// Worker-only: read a published post's cover image into a one-page design
// template (a cover STYLE) — see services/design-editor/cover-styles.ts.
// One Opus vision call (plus one retry on an invalid result), ~20–40s; the
// result lands on the design_cover_styles row the editor polls. Idempotent:
// a row that is no longer pending is skipped.
import type { Task } from "graphile-worker";
import { extractCoverStyle } from "@/lib/services/design-editor/cover-styles";

export interface DesignStyleExtractPayload {
  styleId: string;
}

export const designStyleExtractTask: Task = async (rawPayload, helpers) => {
  const { styleId } = rawPayload as DesignStyleExtractPayload;
  helpers.logger.info(`design-style-extract start style=${styleId}`);
  await extractCoverStyle(styleId, { log: (m) => helpers.logger.info(m) });
};
