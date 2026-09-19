/** Pictures shipped in public/ that any design can use. Client-safe. */
import type { DesignImageSource } from "./doc";

export interface ImageCandidate {
  label: string;
  src: DesignImageSource;
  previewUrl: string;
}

export const BRAND_WORDMARKS: ImageCandidate[] = [
  { label: "Starter Story wordmark (white)", src: { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" }, previewUrl: "/watermarks/starter-story-hubspot-media-white.png" },
  { label: "Starter Story wordmark (black)", src: { kind: "asset", path: "/watermarks/starter-story-hubspot-media-black.png" }, previewUrl: "/watermarks/starter-story-hubspot-media-black.png" },
];
