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
  role: "producer" | "editor";
  assignedByName?: string | null;
  itemUrl: string;
}) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  const title = opts.itemTitle || "(Untitled)";
  const roleLabel = opts.role === "producer" ? "producer" : "editor";
  const assigner = opts.assignedByName || "A teammate";
  const subject = `You were assigned as ${roleLabel} on "${title}"`;
  return getClient().sendEmail({
    From: from,
    To: opts.to,
    Subject: subject,
    TextBody: [
      greeting,
      "",
      `${assigner} assigned you as ${roleLabel} on:`,
      "",
      title,
      "",
      opts.itemUrl,
      "",
      "— Hub & Spoke",
    ].join("\n"),
    HtmlBody: `
      <p>${greeting}</p>
      <p><strong>${escapeHtml(assigner)}</strong> assigned you as <strong>${roleLabel}</strong> on:</p>
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
