import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { fixes } from "@/lib/db/schema";
import { FixRowActions } from "./fix-row-actions";

export const metadata: Metadata = { title: "Fixes" };

const TAB_LABELS = {
  open: "Open",
  in_progress: "In progress",
  needs_decision: "Needs decision",
  done: "Done",
  wont_fix: "Won't fix",
} as const;

const TAB_ORDER = [
  "open",
  "in_progress",
  "needs_decision",
  "done",
  "wont_fix",
] as const;

type Status = (typeof TAB_ORDER)[number];

function isStatus(s: string | undefined): s is Status {
  return !!s && (TAB_ORDER as readonly string[]).includes(s);
}

function relTimeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export default async function FixesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  if (session.user.role !== "admin") {
    return (
      <div className="rounded-lg border border-border bg-card p-6 max-w-xl">
        <h2 className="text-base font-semibold text-foreground">Admins only</h2>
        <p className="text-sm text-muted-foreground mt-1">
          The fixes backlog is admin-only.
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const status: Status = isStatus(sp.status) ? sp.status : "open";

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(fixes)
      .where(eq(fixes.status, status))
      .orderBy(desc(fixes.createdAt))
      .limit(200),
    db
      .select({ status: fixes.status, count: sql<number>`count(*)::int` })
      .from(fixes)
      .groupBy(fixes.status),
  ]);

  const counts: Record<Status, number> = {
    open: 0,
    in_progress: 0,
    needs_decision: 0,
    done: 0,
    wont_fix: 0,
  };
  for (const r of countRows) {
    if (isStatus(r.status)) counts[r.status] = Number(r.count) || 0;
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground mb-1">Fixes</h1>
        <p className="text-sm text-muted-foreground">
          Engineering backlog filed via the fix button. Run{" "}
          <code className="text-xs bg-muted px-1 rounded">/fixthings</code> in a
          Claude Code session (see <code className="text-xs">FIXES.md</code>) to
          burn these down.
        </p>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {TAB_ORDER.map((s) => {
            const active = s === status;
            return (
              <Link
                key={s}
                href={`/fixes?status=${s}`}
                className={
                  "flex-shrink-0 whitespace-nowrap rounded px-3 py-1 text-sm " +
                  (active
                    ? "bg-foreground text-background"
                    : "border border-border bg-card text-foreground hover:bg-muted")
                }
              >
                {TAB_LABELS[s]}
                <span className="ml-1 text-xs opacity-70">({counts[s]})</span>
              </Link>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">
            No {TAB_LABELS[status].toLowerCase()} fixes.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {rows.map((fix) => (
            <div key={fix.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    {fix.category ? (
                      <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        {fix.category.replace(/_/g, " ")}
                      </span>
                    ) : null}
                    {fix.url ? (
                      <a
                        href={fix.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-xs text-blue-600 hover:underline"
                        style={{ maxWidth: "32ch" }}
                      >
                        {(() => {
                          try {
                            const u = new URL(fix.url);
                            return u.pathname + u.search;
                          } catch {
                            return fix.url;
                          }
                        })()}
                      </a>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      filed {relTimeAgo(fix.createdAt)}
                    </span>
                    {fix.filedByEmail ? (
                      <span className="text-xs text-muted-foreground">
                        by {fix.filedByEmail}
                      </span>
                    ) : null}
                  </div>

                  <p className="whitespace-pre-line text-sm text-foreground">
                    {fix.note}
                  </p>

                  {fix.photoKeys && fix.photoKeys.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {fix.photoKeys.map((_key, i) => (
                        <a
                          key={i}
                          href={`/api/fixes/${fix.id}/photo/${i}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/fixes/${fix.id}/photo/${i}`}
                            alt={`fix ${fix.id} photo ${i + 1}`}
                            className="h-20 w-20 rounded border border-border object-cover hover:border-amber-400"
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {fix.resolutionNote ? (
                    <div className="mt-2 rounded bg-muted p-2 text-xs text-muted-foreground">
                      <span className="font-medium">Resolution: </span>
                      {fix.resolutionNote}
                    </div>
                  ) : null}
                </div>

                <FixRowActions
                  fixId={fix.id}
                  currentStatus={fix.status as Status}
                  returnStatus={status}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
