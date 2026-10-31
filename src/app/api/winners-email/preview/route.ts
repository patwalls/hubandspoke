/**
 * Preview of the Monday winners email (`winners-email` task) for anyone with
 * the `winnersEmail` flag — the exact email they'd get.
 *
 *   GET /api/winners-email/preview          → HTML in the browser
 *   GET /api/winners-email/preview?send=me  → sends it to the signed-in user
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { buildWinnersEmail } from "@/lib/winners/email";
import { firstNameOf, loadWinnersEmailBrands } from "@/lib/services/winners/weekly-email";
import { appBaseUrl } from "@/lib/my-work/queries";
import { sendWinnersEmail } from "@/lib/email";

export async function GET(req: NextRequest) {
  const guard = await requireFeature("winnersEmail");
  if (guard.response) return guard.response;

  const email = buildWinnersEmail({
    firstName: firstNameOf(guard.session.user?.name ?? null),
    brands: await loadWinnersEmailBrands(),
    baseUrl: appBaseUrl(),
  });
  if (!email) {
    return new NextResponse("<p>No post on any brand beat its usual last week — Monday's email would not send.</p>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (req.nextUrl.searchParams.get("send") === "me") {
    const to = guard.session.user?.email;
    if (!to) return NextResponse.json({ error: "session has no email" }, { status: 400 });
    await sendWinnersEmail({ to, ...email });
    return NextResponse.json({ sent: true, to, subject: email.subject });
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>${email.subject.replace(/</g, "&lt;")}</title><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:24px auto;"><p style="color:#999;font-size:12px;">Subject: ${email.subject.replace(/</g, "&lt;")}</p>${email.html}</body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
