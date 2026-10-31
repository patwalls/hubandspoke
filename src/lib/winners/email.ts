/**
 * The Monday winners email (milestone 4 of "what's working"): last week's
 * posts that beat their usual on every brand, with why, plus the formats that
 * keep winning. Pure, so the rules are tested; the reads and the send live in
 * the `winners-email` task (src/jobs/tasks/scheduled.ts) via
 * `loadWinnersEmail` (src/lib/services/winners/weekly-email.ts).
 *
 * - No winner on any brand → no email (a "nothing won" email teaches people
 *   to ignore it).
 * - Brands with no winner are left out; brands with the most winners first.
 * - Subject names the biggest lift and its post, so the inbox line alone
 *   says what happened.
 * - Each post line: lift, title (links to the content page), account and
 *   platform, numbers vs. usual, and the "Why:" note when there is one.
 */
import { postTypeDisplay } from "@/lib/platforms";
import { formatLift, measure, type FormatScore, type Winner, type WinnerCandidate } from "./pick";

export interface EmailWinner extends WinnerCandidate {
  accountHandle: string | null;
  platform: string | null;
  /** "tiktok", "instagram_reel" … shown as "TikTok", "Instagram Reel". */
  postType?: string | null;
  format: string | null;
  winNote: { note: string } | null;
}

export interface WinnersEmailBrand {
  slug: string;
  label: string;
  winners: Winner<EmailWinner>[];
  formats: FormatScore[];
}

export interface WinnersEmailInput {
  firstName: string | null;
  brands: WinnersEmailBrand[];
  /** App origin, no trailing slash. */
  baseUrl: string;
}

export interface WinnersEmail {
  subject: string;
  text: string;
  html: string;
}

/** Formats per brand in the email — the top of the dashboard scoreboard. */
export const EMAIL_FORMATS = 3;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function numbers(w: EmailWinner): string {
  const m = measure(w);
  const unit = w.metric === "likes" ? "likes" : "views";
  return `${compact.format(m.value)} ${unit} vs usual ${compact.format(m.usual)}`;
}

function where(w: EmailWinner): string {
  return [
    w.accountHandle ? `@${w.accountHandle.replace(/^@/, "")}` : null,
    (w.postType && postTypeDisplay(w.postType).label) || w.platform,
    w.format,
  ]
    .filter(Boolean)
    .join(" · ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export function buildWinnersEmail(input: WinnersEmailInput): WinnersEmail | null {
  const { baseUrl } = input;
  const brands = input.brands
    .filter((b) => b.winners.length > 0)
    .sort((a, b) => b.winners.length - a.winners.length || a.label.localeCompare(b.label));
  if (brands.length === 0) return null;

  const total = brands.reduce((n, b) => n + b.winners.length, 0);
  const best = brands
    .flatMap((b) => b.winners)
    .reduce((top, w) => (w.lift > top.lift ? w : top));
  const subject = `${total} ${total === 1 ? "post" : "posts"} beat their usual last week — top: ${formatLift(best.lift)} "${truncate(best.item.title || "Untitled", 50)}"`;
  const greeting = input.firstName ? `Morning ${input.firstName},` : "Morning,";
  const itemUrl = (brand: string, id: string) => `${baseUrl}/${brand}/content/${id}`;
  const scoreLine = (f: FormatScore) =>
    `${f.format}: ${f.wins} of ${f.posts} posts${f.bestLift !== null ? ` (best ${formatLift(f.bestLift)})` : ""}`;

  const text = [
    greeting,
    "",
    "Last week's posts that beat their own account's usual, and why.",
    ...brands.flatMap((b) => [
      "",
      `== ${b.label} ==`,
      ...b.winners.map(
        ({ item, lift }) =>
          `- ${formatLift(lift)} ${item.title || "Untitled"} (${where(item)}) — ${numbers(item)}` +
          (item.winNote?.note ? `\n  Why: ${item.winNote.note}` : "") +
          `\n  ${itemUrl(b.slug, item.id)}`,
      ),
      ...(b.formats.length
        ? ["", "Formats that keep beating their usual (4 weeks):", ...b.formats.slice(0, EMAIL_FORMATS).map((f) => `  ${scoreLine(f)}`)]
        : []),
      `Dashboard: ${baseUrl}/${b.slug}`,
    ]),
    "",
    "— Hub & Spoke",
  ].join("\n");

  const brandHtml = brands
    .map(
      (b) => `
      <h3 style="margin:24px 0 6px;font-size:15px;">${escapeHtml(b.label)}</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;border-collapse:collapse;">${b.winners
        .map(
          ({ item, lift }) => `
        <tr>
          <td style="padding:10px 10px 10px 0;border-bottom:1px solid #eee;vertical-align:top;width:52px;color:#059669;font-weight:600;white-space:nowrap;">${formatLift(lift)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">
            <a href="${itemUrl(b.slug, item.id)}" style="color:#111;font-weight:500;text-decoration:none;">${escapeHtml(item.title || "Untitled")}</a>
            <div style="color:#666;font-size:12px;margin-top:2px;">${escapeHtml([where(item), numbers(item)].filter(Boolean).join(" · "))}</div>${
              item.winNote?.note
                ? `
            <div style="color:#333;font-size:13px;margin-top:4px;">Why: ${escapeHtml(item.winNote.note)}</div>`
                : ""
            }
          </td>
        </tr>`,
        )
        .join("")}
      </table>${
        b.formats.length
          ? `
      <p style="margin:12px 0 4px;color:#666;font-size:12px;">Formats that keep beating their usual (4 weeks)</p>
      <ul style="margin:0;padding-left:18px;font-size:13px;">${b.formats
        .slice(0, EMAIL_FORMATS)
        .map((f) => `<li>${escapeHtml(scoreLine(f))}</li>`)
        .join("")}</ul>`
          : ""
      }
      <p style="margin:10px 0 0;font-size:12px;"><a href="${baseUrl}/${b.slug}" style="color:#059669;">Open the ${escapeHtml(b.label)} dashboard</a></p>`,
    )
    .join("");

  const html = `
      <p>${escapeHtml(greeting)}</p>
      <p>Last week's posts that beat their own account's usual, and why.</p>${brandHtml}
      <p style="color:#999;font-size:12px;margin-top:24px;">Compared on views (likes where the platform hides views) against the same account's median for that post type over the 90 days before. You get this on Mondays when something won.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
