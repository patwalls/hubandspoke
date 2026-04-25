/**
 * Admin-only preview of the daily scorecard email.
 *
 *   GET /api/admin/scorecard-email/preview            → HTML rendering in browser
 *   GET /api/admin/scorecard-email/preview?format=text → text body
 *   GET /api/admin/scorecard-email/preview?send=me     → actually sends to the
 *                                                         logged-in admin's email
 *
 * No cron is wired up yet. This route exists so the email can be reviewed
 * (and dogfooded by sending it to ourselves) before a daily send is enabled.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import { getScorecardData } from "@/lib/services/scorecard";
import { renderDailyScorecardEmail } from "@/lib/email-templates/daily-scorecard";
import { sendDailyScorecardEmail } from "@/lib/email";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format");
  const send = searchParams.get("send");

  const data = await getScorecardData();
  const rendered = renderDailyScorecardEmail(data);

  if (send === "me") {
    const to = guard.session.user?.email;
    if (!to) {
      return NextResponse.json(
        { error: "session has no email" },
        { status: 400 }
      );
    }
    await sendDailyScorecardEmail({ to, data });
    return NextResponse.json({
      sent: true,
      to,
      subject: rendered.subject,
    });
  }

  if (format === "text") {
    return new NextResponse(rendered.text, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (format === "json") {
    return NextResponse.json({
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      data,
    });
  }

  // Default: render the HTML body so it shows live in a browser tab.
  // Wrapped in a minimal page chrome that surfaces the subject line, since
  // mail clients show that prominently and we want to review it too.
  const page = `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Scorecard email preview</title>
<style>
  body { margin: 0; padding: 32px; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .meta { max-width: 640px; margin: 0 auto 16px auto; padding: 12px 16px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; font-size: 13px; color: #525252; }
  .meta strong { color: #171717; }
  .meta code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .frame { max-width: 640px; margin: 0 auto; padding: 32px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; }
</style>
</head><body>
  <div class="meta">
    <p style="margin:0 0 4px 0;"><strong>Subject:</strong> ${escapeHtml(rendered.subject)}</p>
    <p style="margin:0;color:#737373;">Preview only — no email sent. Append <code>?send=me</code> to email this to yourself, <code>?format=text</code> for plaintext, <code>?format=json</code> for the raw payload.</p>
  </div>
  <div class="frame">${rendered.html}</div>
</body></html>`;

  return new NextResponse(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
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
