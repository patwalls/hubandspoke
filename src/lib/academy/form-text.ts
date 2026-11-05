import type { AcademyLearnPoint } from "@/lib/db/schema";

/**
 * The video form edits lists as plain text — one item per line — so nobody has
 * to learn a special format. These convert between that text and the stored
 * arrays. A learn-point line may start with a timestamp: "0:18 What is Hub &
 * Spoke", "(0:18) What is…", or "0:18 - What is…".
 */
const LEADING_TIME = /^\(?(\d{1,2}(?::\d{2}){1,2})\)?\s*[-–—:]?\s*/;

export function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\[\s?\])\s+/, "").trim())
    .filter(Boolean);
}

export function linesToLearnPoints(text: string): AcademyLearnPoint[] {
  return linesToList(text).map((line) => {
    const m = line.match(LEADING_TIME);
    if (m && line.length > m[0].length) return { time: m[1], text: line.slice(m[0].length).trim() };
    return { time: null, text: line };
  });
}

export function learnPointsToLines(points: AcademyLearnPoint[]): string {
  return points.map((p) => (p.time ? `${p.time} ${p.text}` : p.text)).join("\n");
}
