import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { loadMyWorkDigest } from "@/lib/my-work/queries";
import { DigestToggle } from "@/components/my-work/digest-toggle";

export const dynamic = "force-dynamic";

/**
 * The My Work morning email (my-day M4): on/off, and the email you'd get if
 * it went out right now — built by the same code the weekday task sends.
 */
export default async function MyWorkEmailPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isFeatureEnabled("myWorkDigest", session.user)) notFound();

  const [me] = await db
    .select({ name: users.name, enabled: users.myWorkDigestEnabled })
    .from(users)
    .where(eq(users.id, session.user.id));
  const digest = await loadMyWorkDigest(session.user.id, me?.name ?? null);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/my-work" className="text-xs text-muted-foreground hover:text-foreground">
          ← My Work
        </Link>
        <h1 className="text-xl font-semibold text-foreground mt-1">Morning email</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Weekday mornings (12:00 UTC, 8am New York): what&apos;s waiting on you and the five to do first. No email on
          days when nothing is waiting.
        </p>
      </div>

      <DigestToggle enabled={me?.enabled ?? true} />

      <div className="rounded-lg border border-border bg-card" data-digest-preview>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">If it went out now</h2>
          {digest && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Subject: <span className="text-foreground">{digest.subject}</span>
            </p>
          )}
        </div>
        {digest ? (
          // Email HTML is built from escaped titles (src/lib/my-work/digest.ts).
          <div
            className="px-6 py-5 bg-white text-[#111] text-sm rounded-b-lg [&_p]:my-2"
            dangerouslySetInnerHTML={{ __html: digest.html }}
          />
        ) : (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            Nothing is waiting on you, so there&apos;d be no email today.
          </div>
        )}
      </div>
    </div>
  );
}
