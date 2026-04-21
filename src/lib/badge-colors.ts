export const STATUS_COLORS: Record<string, string> = {
  Idea: "bg-zinc-100 text-zinc-700 border-zinc-200",
  "To Assign": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Pre-Production": "bg-pink-100 text-pink-800 border-pink-200",
  "Scoping Call": "bg-zinc-100 text-zinc-700 border-zinc-200",
  Outreach: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Review: "bg-yellow-100 text-yellow-800 border-yellow-200",
  "Yes BUT Later": "bg-green-100 text-green-800 border-green-200",
  "Scheduled Shoot": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Editing (V1)": "bg-amber-100 text-amber-900 border-amber-200",
  "Searching/Planning": "bg-sky-100 text-sky-800 border-sky-200",
  "Graphics (V2)": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Scoping Call Done": "bg-blue-100 text-blue-800 border-blue-200",
  "Final Review": "bg-orange-100 text-orange-800 border-orange-200",
  "Ready To Publish": "bg-pink-100 text-pink-800 border-pink-200",
  Published: "bg-pink-50 text-pink-700 border-pink-100",
  Killed: "bg-zinc-100 text-zinc-700 border-zinc-200",
  Assigned: "bg-pink-100 text-pink-800 border-pink-200",
};

export const PLATFORM_COLORS: Record<string, string> = {
  LinkedIn: "bg-amber-100 text-amber-900 border-amber-200",
  X: "bg-violet-100 text-violet-800 border-violet-200",
  "X (Starter Story)": "bg-violet-100 text-violet-800 border-violet-200",
  "X (Pat Walls)": "bg-zinc-100 text-zinc-700 border-zinc-200",
  // Legacy names — retained so pre-migration rows still color correctly.
  Twitter: "bg-violet-100 text-violet-800 border-violet-200",
  "Twitter (Pat Walls)": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Instagram Story": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Instagram Post": "bg-yellow-100 text-yellow-900 border-yellow-200",
  "Instagram Reel": "bg-emerald-100 text-emerald-800 border-emerald-200",
  Newsletter: "bg-pink-100 text-pink-800 border-pink-200",
  "YouTube (SS)": "bg-rose-100 text-rose-800 border-rose-200",
  "YouTube (SS Build)": "bg-violet-100 text-violet-800 border-violet-200",
  "YouTube Community": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "YouTube Shorts": "bg-zinc-100 text-zinc-700 border-zinc-200",
  TikTok: "bg-sky-100 text-sky-800 border-sky-200",
  Threads: "bg-pink-50 text-pink-700 border-pink-100",
  "SS Database": "bg-blue-100 text-blue-800 border-blue-200",
  "SS Case Study": "bg-emerald-100 text-emerald-800 border-emerald-200",
  "Youtube (Pinned Comment)": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Paid Ad": "bg-pink-100 text-pink-800 border-pink-200",
  YouTube: "bg-rose-100 text-rose-800 border-rose-200",
};

const DEFAULT_BADGE = "bg-accent text-muted-foreground border-border";

export function statusClass(status: string | null | undefined): string {
  return (status && STATUS_COLORS[status]) || DEFAULT_BADGE;
}

export function platformClass(platform: string | null | undefined): string {
  return (platform && PLATFORM_COLORS[platform]) || DEFAULT_BADGE;
}
