/**
 * The My Work morning email (my-day M4). Pure, so the rules are tested; the
 * reads and the send live in the `my-work-digest` task
 * (src/jobs/tasks/scheduled.ts).
 *
 * - Nothing waiting (your turn + to review = 0) → no email at all.
 * - Subject leads with the count, so the inbox line alone answers "anything
 *   on me today?".
 * - Top five: sent-back and new-comment rows first (someone is waiting on
 *   you to read them), then To review oldest first, then Your turn.
 * - One button to /my-work, where every row can be acted on.
 * - Each line names the platform ("Instagram Reel"): cross-posts share their
 *   post's title, so without it two lines read the same.
 * - To review lines say how long the post has waited, the subject names the
 *   oldest, and each carries Approve / Already posted / Not this one links to
 *   /my-work/answer/[id] (rules in ./answer.ts), so a reviewer who only reads
 *   the email can clear a post in two taps.
 * - Stuck hand-offs come first (handoffs-dont-stall M3): a To review or Ready
 *   To Publish post that has sat 3+ days in that status (the same rule as the
 *   In Production "waiting Nd" tag, src/lib/production/waiting.ts) ranks right
 *   after send-backs and new comments, its line says how long it has waited,
 *   and one line under the subject counts them. Before this a Ready To Publish
 *   post read just "Ready To Publish" and could sit below five fresh Assigned
 *   rows, so a week-old post looked like any other.
 */
import { postTypeDisplay } from "@/lib/platforms";
import { waitingInStatus } from "@/lib/production/waiting";
import { ANSWERS, waited } from "./answer";
import type { RowNews } from "./news";

export interface DigestRow {
  id: string;
  title: string | null;
  brand: string;
  status: string | null;
  postType?: string | null;
}

export interface DigestInput {
  firstName: string | null;
  yourTurn: DigestRow[];
  toReview: DigestRow[];
  news: ReadonlyMap<string, RowNews>;
  /** When each To review row went into Review (falls back to nothing shown). */
  reviewSince?: ReadonlyMap<string, Date>;
  /** When each Your turn row entered its status (Ready To Publish waits show). */
  turnSince?: ReadonlyMap<string, Date>;
  now?: Date;
  /** App origin, no trailing slash. */
  baseUrl: string;
}

export interface DigestEmail {
  subject: string;
  text: string;
  html: string;
  /** The rows the email lists, in order. `answerable` = a To review row. */
  top: { row: DigestRow; why: string; answerable: boolean }[];
  /** Rows (in or beyond the top) stuck 3+ days in Review / Ready To Publish. */
  stuck: number;
}

export const DIGEST_TOP = 5;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function why(
  row: DigestRow,
  section: "turn" | "review",
  news: RowNews | undefined,
  wait: string | null,
): string {
  if (news?.sentBack) return `Sent back by ${news.sentBack.by}`;
  if (news?.isNew && news.comment) return `New comment from ${news.comment.author}`;
  if (news?.handedBy) return `Handed to you by ${news.handedBy.by}`;
  if (section === "review") return wait ? `To review, waiting ${wait}` : "To review";
  if (wait) return `${row.status ?? "Your turn"}, waiting ${wait}`;
  return row.status ?? "Your turn";
}

export function buildMyWorkDigest(input: DigestInput): DigestEmail | null {
  const { yourTurn, toReview, news, baseUrl, reviewSince, turnSince, now = new Date() } = input;
  const sinceOf = (r: DigestRow, section: "turn" | "review") =>
    (section === "review" ? reviewSince : turnSince)?.get(r.id);
  // To review rows always say their wait (from a day); a Your turn row only
  // once it is a stuck hand-off — "Assigned, waiting 9 days" is normal backlog.
  const waitOf = (r: DigestRow, section: "turn" | "review") => {
    const since = sinceOf(r, section);
    if (!since) return null;
    if (section === "turn" && !isStuck(r, section)) return null;
    return waited(since, now);
  };
  const isStuck = (r: DigestRow, section: "turn" | "review") => {
    const since = sinceOf(r, section);
    const status = section === "review" ? "Review" : r.status;
    return !!since && waitingInStatus(status, since.toISOString(), now.getTime()) !== null;
  };
  const total = yourTurn.length + toReview.length;
  if (total === 0) return null;

  const tagged = [
    ...toReview.map((row) => ({ row, section: "review" as const })),
    ...yourTurn.map((row) => ({ row, section: "turn" as const })),
  ];
  const urgent = (r: DigestRow, section: "turn" | "review") => {
    const n = news.get(r.id);
    return n?.sentBack ? 0 : n?.isNew ? 1 : isStuck(r, section) ? 2 : 3;
  };
  const stuck = tagged.filter((t) => isStuck(t.row, t.section)).length;
  // Stable sort keeps To review (oldest first) ahead of Your turn within a rank.
  const top = tagged
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => urgent(a.row, a.section) - urgent(b.row, b.section) || a.i - b.i)
    .slice(0, DIGEST_TOP)
    .map(({ row, section }) => ({
      row,
      why: why(row, section, news.get(row.id), waitOf(row, section)),
      answerable: section === "review",
    }));

  const oldest = toReview.reduce<Date | null>((min, r) => {
    const since = reviewSince?.get(r.id);
    return since && (!min || since < min) ? since : min;
  }, null);
  const oldestWait = oldest ? waited(oldest, now) : null;
  const parts = [
    yourTurn.length ? plural(yourTurn.length, "on your turn", "on your turn") : null,
    toReview.length
      ? `${toReview.length} to review${oldestWait ? ` (oldest ${oldestWait})` : ""}`
      : null,
  ].filter(Boolean);
  const subject = `${plural(total, "thing", "things")} waiting on you — ${parts.join(", ")}`;
  const greeting = input.firstName ? `Morning ${input.firstName},` : "Morning,";
  const myWorkUrl = `${baseUrl}/my-work`;
  const itemUrl = (r: DigestRow) => `${baseUrl}/${r.brand}/content/${r.id}`;
  const more = total - top.length;
  const stuckLine =
    stuck > 0
      ? `${stuck === 1 ? "1 of these has" : `${stuck} of these have`} waited 3+ days to move on.`
      : null;
  const answerUrl = (r: DigestRow, kind: string) => `${baseUrl}/my-work/answer/${r.id}?a=${kind}`;
  // "starter-story · Instagram Reel" — brand, then the platform when known.
  const where = (r: DigestRow) =>
    [r.brand, postTypeDisplay(r.postType).label].filter(Boolean).join(" · ");

  const text = [
    greeting,
    "",
    `${subject}.`,
    ...(stuckLine ? [stuckLine] : []),
    "",
    ...top.map(
      ({ row, why, answerable }) =>
        `- ${row.title || "(Untitled)"} (${where(row)}) — ${why}\n  ${itemUrl(row)}` +
        (answerable ? ANSWERS.map((a) => `\n  ${a.label}: ${answerUrl(row, a.kind)}`).join("") : ""),
    ),
    ...(more > 0 ? ["", `…and ${more} more.`] : []),
    "",
    `Open My Work: ${myWorkUrl}`,
    "",
    `Turn this email off: ${baseUrl}/my-work/email`,
    "— Hub & Spoke",
  ].join("\n");

  const li = top
    .map(
      ({ row, why, answerable }) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee;">
          <a href="${itemUrl(row)}" style="color:#111;font-weight:500;text-decoration:none;">${escapeHtml(row.title || "(Untitled)")}</a>
          <div style="color:#666;font-size:12px;margin-top:2px;">${escapeHtml(where(row))} · ${escapeHtml(why)}</div>${
            answerable
              ? `
          <div style="margin-top:8px;">${ANSWERS.map(
            (a) =>
              `<a href="${answerUrl(row, a.kind)}" style="display:inline-block;margin:0 6px 4px 0;padding:5px 10px;border:1px solid ${a.kind === "approve" ? "#16a34a" : "#ccc"};border-radius:6px;color:${a.kind === "approve" ? "#16a34a" : "#333"};font-size:12px;text-decoration:none;">${a.label}</a>`,
          ).join("")}</div>`
              : ""
          }
        </td>
      </tr>`,
    )
    .join("");

  const html = `
      <p>${escapeHtml(greeting)}</p>
      <p><strong>${escapeHtml(subject)}</strong>.</p>${
        stuckLine ? `\n      <p style="color:#b45309;font-size:13px;margin-top:-6px;">${escapeHtml(stuckLine)}</p>` : ""
      }
      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;border-collapse:collapse;">${li}
      </table>
      ${more > 0 ? `<p style="color:#666;font-size:13px;">…and ${more} more.</p>` : ""}
      <p style="margin-top:18px;"><a href="${myWorkUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open My Work</a></p>
      <p style="color:#999;font-size:12px;">You get this on weekdays when something is waiting on you. <a href="${baseUrl}/my-work/email" style="color:#999;">Turn it off</a>.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `;

  return { subject, text, html, top, stuck };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
