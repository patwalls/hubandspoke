// Worker-only: read an uploaded PDF (a Canva export) into a format design
// template — see services/design-editor/pdf-import.ts. One Opus call (plus
// one retry on an invalid result); the result lands on the
// design_template_imports row the format page polls. Idempotent: a row that
// is no longer pending is skipped. Never writes formats.design_template.
import type { Task } from "graphile-worker";
import { runTemplateImport } from "@/lib/services/design-editor/pdf-import";

export interface DesignTemplateImportPayload {
  importId: string;
}

export const designTemplateImportTask: Task = async (rawPayload, helpers) => {
  const { importId } = rawPayload as DesignTemplateImportPayload;
  helpers.logger.info(`design-template-import start import=${importId}`);
  await runTemplateImport(importId, { log: (m) => helpers.logger.info(m) });
};
