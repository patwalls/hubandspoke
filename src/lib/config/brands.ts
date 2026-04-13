export const BRANDS = [
  { slug: "starter-story", label: "Starter Story", emoji: "🚀" },
  { slug: "matg", label: "MATG", emoji: "🎙️" },
] as const;

export type BrandSlug = (typeof BRANDS)[number]["slug"];

export const DEFAULT_BRAND: BrandSlug = "starter-story";
