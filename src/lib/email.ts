import { ServerClient } from "postmark";

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
