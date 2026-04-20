import { NextRequest, NextResponse } from "next/server";
import { CRON_JOBS, shouldRunNow } from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // Ad-hoc override: `?name=<jobName>` runs that job regardless of schedule.
  // Same CRON_SECRET gate applies. Useful for re-running a daily scan after
  // a deploy or for validating a job end-to-end without waiting.
  const forceName = request.nextUrl.searchParams.get("name");
  const due = forceName
    ? CRON_JOBS.filter((j) => j.name === forceName)
    : CRON_JOBS.filter((j) => shouldRunNow(j.schedule, now));
  const skipped = forceName
    ? CRON_JOBS.filter((j) => j.name !== forceName).map((j) => j.name)
    : CRON_JOBS.filter((j) => !shouldRunNow(j.schedule, now)).map((j) => j.name);

  if (forceName && due.length === 0) {
    return NextResponse.json(
      { error: `Unknown job: ${forceName}` },
      { status: 404 }
    );
  }

  const results = await Promise.allSettled(
    due.map(async (j) => {
      const start = Date.now();
      try {
        const result = await j.run();
        return {
          name: j.name,
          ok: true,
          ms: Date.now() - start,
          result,
        };
      } catch (err) {
        return {
          name: j.name,
          ok: false,
          ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const ran = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { ok: false, error: String(r.reason) }
  );

  const failed = ran.filter((r) => !r.ok);
  const status = failed.length > 0 ? 207 : 200;

  return NextResponse.json(
    { now: now.toISOString(), ran, skipped },
    { status }
  );
}
