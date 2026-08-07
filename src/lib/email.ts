import { ServerClient } from "postmark";
import {
  renderDailyScorecardEmail,
} from "@/lib/email-templates/daily-scorecard";
import type { ScorecardData } from "@/lib/services/scorecard";

const token = process.env.POSTMARK_TOKEN;
const from = process.env.EMAIL_FROM || "Hub & Spoke <pat@starterstory.com>";

let client: ServerClient | null = null;
function getClient(): ServerClient {
  if (!token) {
    throw new Error("POSTMARK_TOKEN is not set");
  }
  if (!client) client = new ServerClient(token);
  return client;
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  name?: string | null;
}) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: "Reset your Hub & Spoke password",
    TextBody: [
      greeting,
      "",
      "We got a request to reset your Hub & Spoke password. Click the link below to set a new one (the link expires in 1 hour):",
      "",
      opts.resetUrl,
      "",
      "If you didn't ask for this, you can ignore this email.",
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>${greeting}</p>
      <p>We got a request to reset your Hub &amp; Spoke password. Click the button below to set a new one (the link expires in 1 hour):</p>
      <p><a href="${opts.resetUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a></p>
      <p style="color:#666;font-size:12px;">Or paste this link into your browser: <br/><a href="${opts.resetUrl}">${opts.resetUrl}</a></p>
      <p style="color:#999;font-size:12px;">If you didn't ask for this, you can ignore this email.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendAssignmentEmail(opts: {
  to: string;
  name?: string | null;
  itemTitle: string | null;
  assignedByName?: string | null;
  itemUrl: string;
}) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  const title = opts.itemTitle || "(Untitled)";
  const assigner = opts.assignedByName || "A teammate";
  const subject = `You were assigned to "${title}"`;
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: [
      greeting,
      "",
      `${assigner} assigned you to:`,
      "",
      title,
      "",
      opts.itemUrl,
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>${greeting}</p>
      <p><strong>${escapeHtml(assigner)}</strong> assigned you to:</p>
      <p style="margin:16px 0;padding:12px 14px;border-left:3px solid #16a34a;background:#f6fbf7;font-weight:500;">${escapeHtml(title)}</p>
      <p><a href="${opts.itemUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open in Hub &amp; Spoke</a></p>
      <p style="color:#666;font-size:12px;">Or paste this link into your browser: <br/><a href="${opts.itemUrl}">${opts.itemUrl}</a></p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendCommentEmail(opts: {
  to: string;
  name?: string | null;
  itemTitle: string | null;
  commentAuthor: string | null;
  commentBody: string;
  itemUrl: string;
}) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  const title = opts.itemTitle || "(Untitled)";
  const author = opts.commentAuthor || "A teammate";
  const excerpt = opts.commentBody.length > 400
    ? opts.commentBody.slice(0, 400) + "…"
    : opts.commentBody;
  const subject = `${author} commented on "${title}"`;
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: [
      greeting,
      "",
      `${author} commented on "${title}":`,
      "",
      excerpt,
      "",
      opts.itemUrl,
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>${greeting}</p>
      <p><strong>${escapeHtml(author)}</strong> commented on <strong>${escapeHtml(title)}</strong>:</p>
      <blockquote style="margin:16px 0;padding:10px 14px;border-left:3px solid #d4d4d4;background:#fafafa;color:#333;white-space:pre-wrap;">${escapeHtmlWithBreaks(excerpt)}</blockquote>
      <p><a href="${opts.itemUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Reply in Hub &amp; Spoke</a></p>
      <p style="color:#666;font-size:12px;">Or paste this link into your browser: <br/><a href="${opts.itemUrl}">${opts.itemUrl}</a></p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendMentionEmail(opts: {
  to: string;
  name?: string | null;
  itemTitle: string | null;
  commentAuthor: string | null;
  commentBody: string;
  itemUrl: string;
}) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  const title = opts.itemTitle || "(Untitled)";
  const author = opts.commentAuthor || "A teammate";
  const excerpt = opts.commentBody.length > 400
    ? opts.commentBody.slice(0, 400) + "…"
    : opts.commentBody;
  const subject = `${author} mentioned you on "${title}"`;
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: [
      greeting,
      "",
      `${author} mentioned you on "${title}":`,
      "",
      excerpt,
      "",
      opts.itemUrl,
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>${greeting}</p>
      <p><strong>${escapeHtml(author)}</strong> mentioned you on <strong>${escapeHtml(title)}</strong>:</p>
      <blockquote style="margin:16px 0;padding:10px 14px;border-left:3px solid #16a34a;background:#f6fbf7;color:#333;white-space:pre-wrap;">${escapeHtmlWithBreaks(excerpt)}</blockquote>
      <p><a href="${opts.itemUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Reply in Hub &amp; Spoke</a></p>
      <p style="color:#666;font-size:12px;">Or paste this link into your browser: <br/><a href="${opts.itemUrl}">${opts.itemUrl}</a></p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Same as escapeHtml, but also turns newlines into <br /> tags so the email
// HTML preserves the line breaks the author typed. `white-space:pre-wrap`
// alone isn't enough — Gmail and many other clients strip that style on
// inline elements, collapsing the comment onto one line.
function escapeHtmlWithBreaks(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, "<br />");
}

export async function sendInviteEmail(opts: {
  to: string;
  inviteUrl: string;
  inviterName?: string | null;
  inviterEmail: string;
  role: "admin" | "creator";
  expiresAt: Date;
}) {
  const inviter = opts.inviterName || opts.inviterEmail;
  const roleLabel = opts.role === "admin" ? "an admin" : "a member";
  const expiresDate = opts.expiresAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: "You're invited to Hub & Spoke",
    TextBody: [
      "Hi,",
      "",
      `${inviter} invited you to join Hub & Spoke as ${roleLabel}.`,
      "",
      "Click the link below to accept the invite and set your password:",
      "",
      opts.inviteUrl,
      "",
      `This invite expires ${expiresDate}. If you weren't expecting this, you can ignore this email.`,
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>Hi,</p>
      <p><strong>${inviter}</strong> invited you to join Hub &amp; Spoke as <strong>${roleLabel}</strong>.</p>
      <p><a href="${opts.inviteUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Accept invite</a></p>
      <p style="color:#666;font-size:12px;">Or paste this link into your browser: <br/><a href="${opts.inviteUrl}">${opts.inviteUrl}</a></p>
      <p style="color:#999;font-size:12px;">This invite expires ${expiresDate}. If you weren't expecting this, you can ignore this email.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendDailyScorecardEmail(opts: {
  to: string;
  data: ScorecardData;
}) {
  const { subject, text, html } = renderDailyScorecardEmail(opts.data);
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: text,
    HtmlBody: html,
    MessageStream: "outbound",
  });
}

export async function sendDescriptCreditsExhaustedEmail(opts: {
  to: string;
  failedCount: number;
  since: Date | null;
  sampleError: string;
}) {
  const sinceText = opts.since
    ? `since ${opts.since.toLocaleString()} UTC`
    : "in the last hour";
  const subject = "[Hub & Spoke] Descript AI credits exhausted";
  const lines = [
    "Heads up — Descript is rejecting our agent calls because the AI credit budget is out:",
    "",
    `> ${opts.sampleError}`,
    "",
    `${opts.failedCount} Descript job attempt${opts.failedCount === 1 ? "" : "s"} ${sinceText}. Until you top up, every cross-post, repost, and clip-promotion that needs a new Descript composition will sit stuck in the queue — and the affected detail pages will show "Insufficient AI credits" in the Descript Status popover.`,
    "",
    "Top up here: https://web.descript.com/settings/billing",
    "",
    "Once credits are back the queued jobs retry automatically — graphile-worker's exponential backoff caps at 60 min, so the longest-stuck job clears within an hour with no manual rerun needed.",
    "",
    "— Hub & Spoke",
  ];
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: lines.join("\n"),
    HtmlBody: `
      <p>Heads up — Descript is rejecting our agent calls because the AI credit budget is out:</p>
      <blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #dc2626;background:#fef2f2;color:#991b1b;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${opts.sampleError.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</blockquote>
      <p><strong>${opts.failedCount}</strong> Descript job attempt${opts.failedCount === 1 ? "" : "s"} ${sinceText}. Until you top up, every cross-post, repost, and clip-promotion that needs a new Descript composition will sit stuck in the queue — and the affected detail pages will show "Insufficient AI credits" in the Descript Status popover.</p>
      <p><a href="https://web.descript.com/settings/billing" style="background:#dc2626;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Top up Descript</a></p>
      <p style="color:#666;font-size:12px;">Once credits are back the queued jobs retry automatically — graphile-worker's exponential backoff caps at 60 min, so the longest-stuck job clears within an hour with no manual rerun needed.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendScCreditsExhaustedEmail(opts: {
  to: string;
  failedCount: number;
  since: Date | null;
  sampleError: string;
}) {
  const sinceText = opts.since
    ? `since ${opts.since.toLocaleString()} UTC`
    : "in the last hour";
  const subject = "[Hub & Spoke] Scrape Creators credits exhausted";
  const lines = [
    "Heads up — Scrape Creators is rejecting our metric-sync calls with HTTP 402:",
    "",
    `> ${opts.sampleError}`,
    "",
    `${opts.failedCount} sync attempts have failed ${sinceText}. Until you top up, no platform metrics (TikTok / IG / X / YouTube / Threads / LinkedIn) will refresh — items show "—" and the dashboard banner stays red.`,
    "",
    "Top up here: https://app.scrapecreators.com/",
    "",
    "Once credits are back, the next hourly performance-decay sweep will catch every stuck row automatically — no code or manual backfill needed.",
    "",
    "— Hub & Spoke",
  ];
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: lines.join("\n"),
    HtmlBody: `
      <p>Heads up — Scrape Creators is rejecting our metric-sync calls with HTTP 402:</p>
      <blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #dc2626;background:#fef2f2;color:#991b1b;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${opts.sampleError.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</blockquote>
      <p><strong>${opts.failedCount}</strong> sync attempts have failed ${sinceText}. Until you top up, no platform metrics (TikTok / IG / X / YouTube / Threads / LinkedIn) will refresh — items show "—" and the dashboard banner stays red.</p>
      <p><a href="https://app.scrapecreators.com/" style="background:#dc2626;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Top up Scrape Creators</a></p>
      <p style="color:#666;font-size:12px;">Once credits are back, the next hourly performance-decay sweep will catch every stuck row automatically — no code or manual backfill needed.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}

export async function sendYtArchiveBehindEmail(opts: {
  to: string;
  staleCount: number;
  oldestPublishedAt: Date | null;
  sample: Array<{ id: string; title: string | null; brand: string | null; publishedDate: string | null }>;
}) {
  const oldestText = opts.oldestPublishedAt
    ? `oldest published ${opts.oldestPublishedAt.toISOString().slice(0, 10)}`
    : "age unknown";
  const subject = "[Hub & Spoke] YouTube archiver is behind";
  const sampleLinesText = opts.sample
    .map((s) => `  - [${s.brand ?? "?"}] ${s.title ?? s.id} (published ${s.publishedDate ?? "?"})`)
    .join("\n");
  const sampleLinesHtml = opts.sample
    .map(
      (s) =>
        `<li>[${(s.brand ?? "?").replace(/&/g, "&amp;").replace(/</g, "&lt;")}] ${(s.title ?? s.id).replace(/&/g, "&amp;").replace(/</g, "&lt;")} (published ${s.publishedDate ?? "?"})</li>`,
    )
    .join("");
  // Deliberately does NOT assert a cause. This alert only knows that items are
  // not getting archived — it cannot tell "the Mac is off" from "downloads are
  // failing" from "Heroku creds expired". It claimed "has likely stopped
  // running" twice in a row (2026-07-30, 2026-08-06) and was wrong about the
  // reason both times, sending people to `heroku login` for a memory problem
  // and to the launchd job for a credentials problem. The log is authoritative;
  // this email's job is to point at it and decode what's found there.
  const lines = [
    `Heads up — ${opts.staleCount} published YouTube item(s) have had ZERO download attempts for over 12 hours (${oldestText}). The home-machine hourly archiver is not completing its runs; the cause is in the log on the Mac.`,
    "",
    sampleLinesText,
    "",
    "Check on the designated Mac:",
    "  tail -50 ~/Library/Logs/hubandspoke-yt-archive.log",
    "  launchctl list | grep yt-archive   # 2nd column = last exit code",
    "",
    "What the exit code means:",
    "  0 / 2  ran fine — if items are still missing, they are per-video failures, not a broken cron",
    "  6      Heroku credentials expired (chronic). Fix permanently:",
    "           heroku login && heroku authorizations:create -d 'yt-archive home cron'",
    "         then add HEROKU_API_KEY=<token> to ~/.config/hubandspoke/yt-archive.env",
    "  8      host out of memory — the log names the top consumer (usually the ollama judge model)",
    "  other  the wrapper bailed before starting; the log line says why",
    "",
    "The in-dyno youtube-download-sweep is a deliberate noop in production (YouTube bot-blocks datacenter IPs), so nothing else picks this up — once the cron is healthy again it backfills automatically on its next hourly tick.",
    "",
    "— Hub & Spoke",
  ];
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: lines.join("\n"),
    HtmlBody: `
      <p>Heads up — <strong>${opts.staleCount}</strong> published YouTube item(s) have had <strong>zero download attempts</strong> for over 12 hours (${oldestText}). The home-machine hourly archiver is <strong>not completing its runs</strong>; the cause is in the log on the Mac.</p>
      <ul style="color:#374151;font-size:13px;">${sampleLinesHtml}</ul>
      <p>Check on the designated Mac:</p>
      <pre style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #dc2626;background:#fef2f2;color:#991b1b;font-family:ui-monospace,Menlo,monospace;font-size:12px;">tail -50 ~/Library/Logs/hubandspoke-yt-archive.log
launchctl list | grep yt-archive   # 2nd column = last exit code</pre>
      <p style="margin:0 0 6px;">What the exit code means:</p>
      <table style="border-collapse:collapse;font-size:12px;color:#374151;margin:0 0 12px;">
        <tr><td style="padding:2px 10px 2px 0;font-family:ui-monospace,Menlo,monospace;"><strong>0 / 2</strong></td><td style="padding:2px 0;">ran fine — remaining gaps are per-video failures, not a broken cron</td></tr>
        <tr><td style="padding:2px 10px 2px 0;font-family:ui-monospace,Menlo,monospace;"><strong>6</strong></td><td style="padding:2px 0;">Heroku credentials expired (chronic) — <code>heroku login &amp;&amp; heroku authorizations:create -d 'yt-archive home cron'</code>, then add <code>HEROKU_API_KEY=&lt;token&gt;</code> to <code>~/.config/hubandspoke/yt-archive.env</code></td></tr>
        <tr><td style="padding:2px 10px 2px 0;font-family:ui-monospace,Menlo,monospace;"><strong>8</strong></td><td style="padding:2px 0;">host out of memory — the log names the top consumer (usually the ollama judge model)</td></tr>
        <tr><td style="padding:2px 10px 2px 0;font-family:ui-monospace,Menlo,monospace;"><strong>other</strong></td><td style="padding:2px 0;">wrapper bailed before starting; the log line says why</td></tr>
      </table>
      <p style="color:#666;font-size:12px;">The in-dyno youtube-download-sweep is a deliberate noop in production (YouTube bot-blocks datacenter IPs), so nothing else picks this up — once the cron is healthy again it backfills automatically on its next hourly tick.</p>
      <p style="color:#999;font-size:12px;">— Hub &amp; Spoke</p>
    `,
    MessageStream: "outbound",
  });
}
