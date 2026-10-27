// Pre-send checks for a ready draft — what HubSpot's "check for errors" and
// beehiiv's send dialog do: empty required sections, placeholders still in
// the text, screenshots never picked, a sponsor slot waiting on copy, subject
// and preview text sanity, and every link / image actually reachable (one
// HEAD-then-GET per unique URL, bounded). No AI. `findIssues` is pure;
// `checkLinks` does the network.

import { parseScreenshotMarks, type ChosenScreenshot } from "@/lib/newsletter-screenshots";
import { screenshotKey } from "@/lib/newsletter-screenshots";
import type { NewsletterSection, NewsletterTemplate } from "@/lib/newsletter-template";

export interface PreSendCheck {
  kind: string;
  level: "error" | "warn" | "ok";
  message: string;
  sectionKey?: string | null;
  url?: string;
}

const LINK_RE = /\]\((https?:\/\/[^)\s]+)\)/g;
const SUBJECT_MAX = 60;
export const MAX_LINKS_CHECKED = 25;
const FETCH_TIMEOUT_MS = 6_000;

/** Every http(s) link + image URL in the sections' Markdown, unique, in order. Pure. */
export function collectUrls(sections: NewsletterSection[]): { url: string; sectionKey: string; image: boolean }[] {
  const out: { url: string; sectionKey: string; image: boolean }[] = [];
  const seen = new Set<string>();
  for (const sec of sections) {
    for (const m of sec.markdown.matchAll(/(!?)\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
      const url = m[2];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, sectionKey: sec.key, image: m[1] === "!" });
    }
  }
  return out;
}

/** The content checks (no network). Pure; exported for tests. */
export function findIssues(args: {
  template: NewsletterTemplate;
  sections: NewsletterSection[];
  subject: string | null;
  previewText: string | null;
  specialCopy: string | null;
  specialCopyFrom?: "subtask" | "focus_field" | null;
  /** "removed": the ad was taken out of this issue on purpose. */
  specialMode?: string | null;
  screenshots: Record<string, ChosenScreenshot>;
}): PreSendCheck[] {
  const out: PreSendCheck[] = [];
  const byKey = new Map(args.sections.map((s) => [s.key, s.markdown]));
  const subject = (args.subject ?? "").trim();
  if (!subject) out.push({ kind: "subject", level: "error", message: "No subject line." });
  else if (subject.length > SUBJECT_MAX) out.push({ kind: "subject", level: "warn", message: `Subject is ${subject.length} characters — inboxes cut it around ${SUBJECT_MAX}.` });
  else out.push({ kind: "subject", level: "ok", message: `Subject: ${subject.length} characters.` });
  if (!(args.previewText ?? "").trim()) out.push({ kind: "preview", level: "warn", message: "No preview text — the inbox will show the first line of the email instead." });
  else out.push({ kind: "preview", level: "ok", message: "Preview text set." });

  for (const sec of args.template.sections) {
    const md = (byKey.get(sec.key) ?? "").trim();
    const label = sec.heading ?? sec.key.replace(/_/g, " ");
    if (sec.kind === "sponsor") {
      if (args.specialCopy?.trim()) {
        if (args.specialCopyFrom === "focus_field") out.push({ kind: "sponsor", level: "warn", message: `${label}: the sponsor copy is a placeholder from the Asana form (no "Final Newsletter Copy" subtask yet).`, sectionKey: sec.key });
        else out.push({ kind: "sponsor", level: "ok", message: `${label}: ${args.specialCopyFrom ? "sponsor copy from Asana" : "ad copy set"}.`, sectionKey: sec.key });
      } else if (args.specialMode === "removed" && !md) out.push({ kind: "sponsor", level: "ok", message: `${label}: ad taken out of this issue.`, sectionKey: sec.key });
      else if (!md) out.push({ kind: "sponsor", level: "warn", message: `${label} is empty — no sponsor booked and nothing written.`, sectionKey: sec.key });
      continue;
    }
    if (!md) {
      out.push({ kind: "empty", level: sec.optional ? "ok" : "error", message: sec.optional ? `${label} left out (optional).` : `${label} is empty.`, sectionKey: sec.key });
      continue;
    }
    if (/\[PLACEHOLDER|\(#\)|\bTODO\b|\bTK\b|lorem ipsum/i.test(md)) out.push({ kind: "placeholder", level: "error", message: `${label} still has placeholder text.`, sectionKey: sec.key });
    const marks = parseScreenshotMarks(sec.key, md);
    const unpicked = marks.filter((m) => !args.screenshots[screenshotKey(sec.key, m.label)]);
    if (unpicked.length) out.push({ kind: "screenshot", level: "warn", message: `${label}: ${unpicked.length} screenshot spot${unpicked.length === 1 ? "" : "s"} without an image — left out of the email.`, sectionKey: sec.key });
    if (/\]\(\s*\)|\]\(https?:\/\/(example\.com|x\.example)/i.test(md)) out.push({ kind: "link", level: "error", message: `${label} has an empty or example link.`, sectionKey: sec.key });
  }
  return out;
}

/** Fetch each URL (HEAD, then GET on 405/4xx-without-body) and report the dead ones. Bounded: first MAX_LINKS_CHECKED, 5 at a time, 6s each. */
export async function checkLinks(urls: { url: string; sectionKey: string; image: boolean }[], fetchFn: typeof fetch = fetch): Promise<PreSendCheck[]> {
  const out: PreSendCheck[] = [];
  const todo = urls.slice(0, MAX_LINKS_CHECKED);
  const probe = async (u: { url: string; sectionKey: string; image: boolean }): Promise<PreSendCheck> => {
    const attempt = async (method: "HEAD" | "GET") => {
      const res = await fetchFn(u.url, { method, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "HubAndSpoke-LinkCheck/1.0" } });
      return res;
    };
    try {
      let res = await attempt("HEAD");
      if (res.status === 405 || res.status === 403 || res.status === 404) res = await attempt("GET");
      if (!res.ok) return { kind: u.image ? "image" : "link", level: "error", message: `${u.image ? "Image" : "Link"} returns ${res.status}: ${u.url}`, sectionKey: u.sectionKey, url: u.url };
      if (u.image && !(res.headers.get("content-type") ?? "").startsWith("image/")) return { kind: "image", level: "warn", message: `Image URL doesn't serve an image: ${u.url}`, sectionKey: u.sectionKey, url: u.url };
      return { kind: u.image ? "image" : "link", level: "ok", message: `${u.image ? "Image" : "Link"} OK: ${u.url}`, sectionKey: u.sectionKey, url: u.url };
    } catch (err) {
      return { kind: u.image ? "image" : "link", level: "error", message: `${u.image ? "Image" : "Link"} unreachable (${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}): ${u.url}`, sectionKey: u.sectionKey, url: u.url };
    }
  };
  for (let i = 0; i < todo.length; i += 5) out.push(...(await Promise.all(todo.slice(i, i + 5).map(probe))));
  if (urls.length > MAX_LINKS_CHECKED) out.push({ kind: "link", level: "warn", message: `${urls.length - MAX_LINKS_CHECKED} more links weren't checked (limit ${MAX_LINKS_CHECKED}).` });
  return out;
}
