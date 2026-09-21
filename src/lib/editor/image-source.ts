/**
 * A durable reference to a picture, shared by the design editor's image
 * elements and the clip editor's image layers. The document stores this;
 * a browser URL is resolved from it when the editor opens
 * (`previewUrlFor` in services/design-editor/assets.ts) and the renderers
 * fetch it themselves.
 */
import { z } from "zod";

export const imageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url().max(2000) }),
  z.object({ kind: z.literal("s3"), bucket: z.string().nullable(), key: z.string().min(1) }),
  /** A file under public/ (brand logos, watermarks) — "/watermarks/x.png". */
  z.object({ kind: z.literal("asset"), path: z.string().regex(/^\/[a-zA-Z0-9_\-./]+$/) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

/** Stable identity for de-duplicating candidate lists. */
export function imageSourceKey(src: ImageSource): string {
  return src.kind === "url" ? `url:${src.url}` : src.kind === "s3" ? `s3:${src.bucket ?? ""}:${src.key}` : `asset:${src.path}`;
}
