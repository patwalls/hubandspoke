import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Jobs · Settings" };
export const dynamic = "force-dynamic";

interface TaskSummaryRow {
  task_identifier: string;
  pending: number;
  running: number;
  failed: number;
  max_attempts: number | null;
}

interface RecentJobRow {
  id: string;
  task_identifier: string;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  last_error: string | null;
  key: string | null;
}

interface CrontabRow {
  identifier: string;
  last_execution: Date | null;
}

function fmtAgo(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 0) return `in ${Math.round(-ms / 1000)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Summary by task_identifier: pending (unlocked, attempts<max), running (locked),
  // failed (attempts>=max). The jobs view is the public-facing read surface —
  // private `_private_jobs` is the storage.
  const summary = (await db.execute(sql`
    SELECT
      task_identifier,
      COUNT(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts) AS pending,
      COUNT(*) FILTER (WHERE locked_at IS NOT NULL) AS running,
      COUNT(*) FILTER (WHERE attempts >= max_attempts) AS failed,
      MAX(max_attempts) AS max_attempts
    FROM graphile_worker.jobs
    GROUP BY task_identifier
    ORDER BY task_identifier ASC
  `)) as unknown as TaskSummaryRow[];

  const recent = (await db.execute(sql`
    SELECT id::text, task_identifier, run_at, attempts, max_attempts, locked_at, last_error, key
    FROM graphile_worker.jobs
    ORDER BY run_at DESC
    LIMIT 50
  `)) as unknown as RecentJobRow[];

  // Crontab state lives in the private table; there's no public view for it.
  const crontabs = (await db.execute(sql`
    SELECT identifier, last_execution
    FROM graphile_worker._private_known_crontabs
    ORDER BY identifier ASC
  `)) as unknown as CrontabRow[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Background jobs
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Live state of the <code className="text-xs">graphile_worker</code>{" "}
          queue that backs transcript fetches, scheduled cron, notifications,
          and enrichment. Read-only snapshot — refresh the page for a newer
          view.
        </p>
      </div>

      <section>
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
          Queue by task
        </h3>
        {summary.length === 0 ? (
          <p className="text-xs text-muted-foreground">Queue is empty.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Task</th>
                  <th className="text-right px-3 py-2">Pending</th>
                  <th className="text-right px-3 py-2">Running</th>
                  <th className="text-right px-3 py-2">Failed</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.task_identifier} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.task_identifier}
                    </td>
                    <td className="text-right px-3 py-2">{Number(row.pending)}</td>
                    <td className="text-right px-3 py-2">{Number(row.running)}</td>
                    <td className="text-right px-3 py-2 text-red-600 font-medium">
                      {Number(row.failed)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
          Scheduled (crontab)
        </h3>
        {crontabs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No crontab entries registered yet — first worker boot creates them.
          </p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Task</th>
                  <th className="text-left px-3 py-2">Last fired</th>
                </tr>
              </thead>
              <tbody>
                {crontabs.map((c) => (
                  <tr key={c.identifier} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      {c.identifier}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtAgo(c.last_execution)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
          Recent jobs (50)
        </h3>
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No jobs on the queue.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Task</th>
                  <th className="text-left px-3 py-2">Run at</th>
                  <th className="text-right px-3 py-2">Attempts</th>
                  <th className="text-left px-3 py-2">State</th>
                  <th className="text-left px-3 py-2">Last error</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((job) => {
                  const failed = job.attempts >= job.max_attempts;
                  const running = !!job.locked_at;
                  const state = failed
                    ? "failed"
                    : running
                      ? "running"
                      : job.attempts > 0
                        ? `retry ${job.attempts}/${job.max_attempts}`
                        : "pending";
                  return (
                    <tr key={job.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 font-mono text-xs">
                        {job.task_identifier}
                        {job.key && (
                          <div className="text-[11px] text-muted-foreground">
                            {job.key}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {fmtAgo(job.run_at)}
                      </td>
                      <td className="text-right px-3 py-2">
                        {job.attempts}/{job.max_attempts}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            failed
                              ? "text-red-600 font-medium"
                              : running
                                ? "text-amber-600"
                                : "text-muted-foreground"
                          }
                        >
                          {state}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[11px] text-red-600 font-mono max-w-[360px] truncate">
                        {job.last_error ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
