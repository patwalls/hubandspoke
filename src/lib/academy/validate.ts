import { z } from "zod";

/** Request bodies for the Academy admin + progress endpoints. */

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  trimmed(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const learnPointSchema = z.object({
  time: optionalText(12),
  text: trimmed(300).min(1),
});

export const videoInputSchema = z.object({
  categoryId: z.string().uuid(),
  title: trimmed(200).min(1, "Title is required"),
  summary: optionalText(400),
  videoUrl: optionalText(1000),
  durationLabel: optionalText(40),
  learnPoints: z.array(learnPointSchema).max(50).default([]),
  actionItems: z.array(trimmed(400).min(1)).max(50).default([]),
  notes: optionalText(200000),
  comingSoon: z.boolean().default(false),
});
export type VideoInput = z.infer<typeof videoInputSchema>;

export const categoryInputSchema = z.object({
  name: trimmed(120).min(1, "Name is required"),
  description: optionalText(400),
});

export const reorderSchema = z.object({
  kind: z.enum(["videos", "categories"]),
  ids: z.array(z.string().uuid()).min(1).max(500),
  // videos only: the category these ids now belong to (drag into another category).
  categoryId: z.string().uuid().optional(),
});

export const progressSchema = z.object({
  checkedItems: z.array(trimmed(400)).max(50).optional(),
  completed: z.boolean().optional(),
});

/** URL slug from a title: "Set Up Your Brand & Accounts" → "set-up-your-brand-accounts". */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "video"
  );
}
