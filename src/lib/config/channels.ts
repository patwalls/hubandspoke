export const SS_CHANNELS = [
  "YouTube (SS)",
  "YouTube (SS Build)",
  "YouTube Shorts",
  "YouTube Community",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "Twitter",
  "LinkedIn",
  "TikTok",
  "Threads",
  "Newsletter",
  "SS Case Study",
  "SS Database",
  "Paid Ad",
];

export const MATG_CHANNELS = [
  "YouTube",
  "YouTube Shorts",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "Twitter",
  "LinkedIn",
  "TikTok",
  "Threads",
];

export function channelsForBrand(brand: string): string[] {
  return brand === "matg" ? MATG_CHANNELS : SS_CHANNELS;
}
