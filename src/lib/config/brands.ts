export const BRANDS = [
  {
    slug: "starter-story",
    label: "Starter Story",
    avatar: "/brands/starter-story.jpg",
    color: "from-emerald-500 to-emerald-700",
    disabled: false,
  },
  {
    slug: "matg",
    label: "Marketing Against The Grain",
    avatar: "/brands/matg.jpg",
    color: "from-orange-500 to-rose-600",
    disabled: false,
  },
  {
    slug: "my-first-million",
    label: "My First Million",
    avatar: "/brands/my-first-million.jpg",
    color: "from-amber-500 to-yellow-600",
    disabled: true,
  },
  {
    slug: "science-of-scaling",
    label: "Science Of Scaling",
    avatar: "/brands/science-of-scaling.jpg",
    color: "from-sky-500 to-indigo-600",
    disabled: true,
  },
] as const;

export type BrandSlug = (typeof BRANDS)[number]["slug"];

export const DEFAULT_BRAND: BrandSlug = "starter-story";
