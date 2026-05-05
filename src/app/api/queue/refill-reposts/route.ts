import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { enqueue } from "@/jobs/enqueue";

export const dynamic = "force-dynamic";

// On-demand trigger for the same `evergreen-scan` task that runs daily at
// 15:00 UTC. The scan is global (all brands) by design — the underlying
// service classifies and refills per platform quotas across every brand. We
// don't accept a brand param here because the scan doesn't either; if/when it
// becomes brand-scoped, we can pipe a brand through.
//
// Cost: ~$0.01–0.05 of gpt-4.1-mini per run (one fit-check per evergreen
// candidate that passes Phase A). Cheap enough that admin-gated UI exposure
// is fine.
export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // No payload needed; evergreen-scan is registered with `Record<string, never>`.
  await enqueue("evergreen-scan", {});

  return NextResponse.json({ status: "enqueued" }, { status: 202 });
}
