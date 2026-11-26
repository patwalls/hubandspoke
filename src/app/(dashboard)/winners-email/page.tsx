import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { appBaseUrl } from "@/lib/my-work/queries";
import { buildWinnersEmail } from "@/lib/winners/email";
import { firstNameOf, loadWinnersEmailBrands } from "@/lib/services/winners/weekly-email";
import { DigestToggle } from "@/components/my-work/digest-toggle";

export const dynamic = "force-dynamic";

/**
 * The Monday winners email: on/off (every email's footer links here), and the
 * email you'd get if it went out right now — built by the same code the
 * `winners-email` task sends.
 */
export default async function WinnersEmailPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isFeatureEnabled("winnersEmail", session.user)) notFound();

  const [me] = await db
    .select({ name: users.name, enabled: users.winnersEmailEnabled })
    .from(users)
    .where(eq(users.id, session.user.id));
  const email = buildWinnersEmail({
    firstName: firstNameOf(me?.name ?? null),
    brands: await loadWinnersEmailBrands(),
    baseUrl: appBaseUrl(),
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <h1 className="text-xl font-semibold text-foreground mt-1">Monday winners email</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Mondays (13:00 UTC, 8am New York): last week&apos;s posts on every brand that beat their own account&apos;s
          usual, and why, plus the formats that keep winning. No email in a week when nothing won.
        </p>
      </div>

      <DigestToggle
        enabled={me?.enabled ?? true}
        endpoint="/api/winners-email"
        label="Monday email"
        mark="winners-email"
      />

      <div className="rounded-lg border border-border bg-card" data-winners-email-preview>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">If it went out now</h2>
          {email && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Subject: <span className="text-foreground">{email.subject}</span>
            </p>
          )}
        </div>
        {email ? (
          // Email HTML is built from escaped titles and notes (src/lib/winners/email.ts).
          <div
            className="px-6 py-5 bg-white text-[#111] text-sm rounded-b-lg [&_p]:my-2"
            dangerouslySetInnerHTML={{ __html: email.html }}
          />
        ) : (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No post on any brand beat its usual in the last 7 days, so there&apos;d be no email this week.
          </div>
        )}
      </div>
    </div>
  );
}
