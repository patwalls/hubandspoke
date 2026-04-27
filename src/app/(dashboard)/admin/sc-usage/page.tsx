import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { scCallLog, accounts } from "@/lib/db/schema";
import { sql, desc, eq, gte } from "drizzle-orm";

export const metadata: Metadata = { title: "SC Usage" };
export const dynamic = "force-dynamic";

type TotalsRow = { credits: number; calls: number };

async function getTotals(sinceMs: number): Promise<TotalsRow> {
  const since = new Date(sinceMs);
  const [row] = await db
    .select({
      credits: sql<number>`COALESCE(SUM(${scCallLog.credits}), 0)::int`,
      calls: sql<number>`COUNT(*)::int`,
    })
    .from(scCallLog)
    .where(gte(scCallLog.createdAt, since));
  return row ?? { credits: 0, calls: 0 };
}

interface CallerRow {
  caller: string;
  calls: number;
  credits: number;
  errors: number;
}

async function getByCaller(sinceMs: number): Promise<CallerRow[]> {
  const since = new Date(sinceMs);
  return db
    .select({
      caller: scCallLog.caller,
      calls: sql<number>`COUNT(*)::int`,
      credits: sql<number>`COALESCE(SUM(${scCallLog.credits}), 0)::int`,
      errors: sql<number>`COUNT(*) FILTER (WHERE ${scCallLog.ok} = false)::int`,
    })
    .from(scCallLog)
    .where(gte(scCallLog.createdAt, since))
    .groupBy(scCallLog.caller)
    .orderBy(desc(sql`SUM(${scCallLog.credits})`));
}

interface AccountRow {
  accountId: string | null;
  handle: string | null;
  platform: string | null;
  calls: number;
  credits: number;
}

async function getByAccount(sinceMs: number): Promise<AccountRow[]> {
  const since = new Date(sinceMs);
  return db
    .select({
      accountId: scCallLog.accountId,
      handle: accounts.handle,
      platform: accounts.platform,
      calls: sql<number>`COUNT(*)::int`,
      credits: sql<number>`COALESCE(SUM(${scCallLog.credits}), 0)::int`,
    })
    .from(scCallLog)
    .leftJoin(accounts, eq(accounts.id, scCallLog.accountId))
    .where(gte(scCallLog.createdAt, since))
    .groupBy(scCallLog.accountId, accounts.handle, accounts.platform)
    .orderBy(desc(sql`SUM(${scCallLog.credits})`));
}

interface PlatformRow {
  platform: string | null;
  calls: number;
  credits: number;
}

async function getByPlatform(sinceMs: number): Promise<PlatformRow[]> {
  const since = new Date(sinceMs);
  return db
    .select({
      platform: scCallLog.platform,
      calls: sql<number>`COUNT(*)::int`,
      credits: sql<number>`COALESCE(SUM(${scCallLog.credits}), 0)::int`,
    })
    .from(scCallLog)
    .where(gte(scCallLog.createdAt, since))
    .groupBy(scCallLog.platform)
    .orderBy(desc(sql`SUM(${scCallLog.credits})`));
}

interface RecentRow {
  id: string;
  caller: string;
  accountId: string | null;
  productionItemId: string | null;
  platform: string | null;
  credits: number;
  itemsCreated: number | null;
  itemsUpdated: number | null;
  ok: boolean;
  notes: string | null;
  durationMs: number | null;
  createdAt: Date;
}

async function getRecent(): Promise<RecentRow[]> {
  return db
    .select({
      id: scCallLog.id,
      caller: scCallLog.caller,
      accountId: scCallLog.accountId,
      productionItemId: scCallLog.productionItemId,
      platform: scCallLog.platform,
      credits: scCallLog.credits,
      itemsCreated: scCallLog.itemsCreated,
      itemsUpdated: scCallLog.itemsUpdated,
      ok: scCallLog.ok,
      notes: scCallLog.notes,
      durationMs: scCallLog.durationMs,
      createdAt: scCallLog.createdAt,
    })
    .from(scCallLog)
    .orderBy(desc(scCallLog.createdAt))
    .limit(50);
}

function fmtAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export default async function ScUsagePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const sevenDaysAgoMs = now - 7 * DAY;
  const thirtyDaysAgoMs = now - 30 * DAY;

  const [today, sevenDays, thirtyDays, byCaller, byAccount, byPlatform, recent] =
    await Promise.all([
      getTotals(todayMs),
      getTotals(sevenDaysAgoMs),
      getTotals(thirtyDaysAgoMs),
      getByCaller(sevenDaysAgoMs),
      getByAccount(sevenDaysAgoMs),
      getByPlatform(sevenDaysAgoMs),
      getRecent(),
    ]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Scrape Creators usage
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Per-task SC credit spend. One row per task invocation (not per HTTP
          call). Logged from each SC-hitting code path; backfill scripts and
          calls before this page shipped won&apos;t appear.
        </p>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Tile label="Today" credits={today.credits} calls={today.calls} />
        <Tile
          label="Last 7 days"
          credits={sevenDays.credits}
          calls={sevenDays.calls}
          subtitle={`avg ${Math.round(sevenDays.credits / 7).toLocaleString()} cr/day`}
        />
        <Tile
          label="Last 30 days"
          credits={thirtyDays.credits}
          calls={thirtyDays.calls}
          subtitle={`avg ${Math.round(thirtyDays.credits / 30).toLocaleString()} cr/day`}
        />
      </div>

      {/* By caller */}
      <Section title="By caller (last 7 days)">
        {byCaller.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Caller</th>
                <th className="text-right px-3 py-2">Calls</th>
                <th className="text-right px-3 py-2">Credits</th>
                <th className="text-right px-3 py-2">Cr / day</th>
                <th className="text-right px-3 py-2">Errors</th>
              </tr>
            </thead>
            <tbody>
              {byCaller.map((r) => (
                <tr key={r.caller} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{r.caller}</td>
                  <td className="text-right px-3 py-2 text-muted-foreground">
                    {r.calls.toLocaleString()}
                  </td>
                  <td className="text-right px-3 py-2 font-medium">
                    {r.credits.toLocaleString()}
                  </td>
                  <td className="text-right px-3 py-2 text-muted-foreground">
                    {Math.round(r.credits / 7).toLocaleString()}
                  </td>
                  <td
                    className={`text-right px-3 py-2 ${
                      r.errors > 0 ? "text-red-600" : "text-muted-foreground"
                    }`}
                  >
                    {r.errors > 0 ? r.errors.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* By account */}
      <Section title="By account (last 7 days)">
        {byAccount.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Account</th>
                <th className="text-left px-3 py-2">Platform</th>
                <th className="text-right px-3 py-2">Calls</th>
                <th className="text-right px-3 py-2">Credits</th>
              </tr>
            </thead>
            <tbody>
              {byAccount.map((r) => (
                <tr
                  key={r.accountId ?? "_null"}
                  className="border-t border-border"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.handle ?? (r.accountId ? "(deleted)" : "—")}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {r.platform ?? "—"}
                  </td>
                  <td className="text-right px-3 py-2 text-muted-foreground">
                    {r.calls.toLocaleString()}
                  </td>
                  <td className="text-right px-3 py-2 font-medium">
                    {r.credits.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* By platform */}
      <Section title="By platform (last 7 days)">
        {byPlatform.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Platform</th>
                <th className="text-right px-3 py-2">Calls</th>
                <th className="text-right px-3 py-2">Credits</th>
              </tr>
            </thead>
            <tbody>
              {byPlatform.map((r, i) => (
                <tr key={r.platform ?? `null-${i}`} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.platform ?? "—"}
                  </td>
                  <td className="text-right px-3 py-2 text-muted-foreground">
                    {r.calls.toLocaleString()}
                  </td>
                  <td className="text-right px-3 py-2 font-medium">
                    {r.credits.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Recent */}
      <Section title="Recent (last 50)">
        {recent.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40 font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Caller</th>
                <th className="text-left px-3 py-2">Platform</th>
                <th className="text-right px-3 py-2">Cr</th>
                <th className="text-right px-3 py-2">Dur</th>
                <th className="text-left px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t border-border ${
                    !r.ok ? "bg-red-50/40" : ""
                  }`}
                >
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                    {fmtAge(r.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.caller}</td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {r.platform ?? "—"}
                  </td>
                  <td className="text-right px-3 py-2 font-medium">
                    {r.credits}
                  </td>
                  <td className="text-right px-3 py-2 text-muted-foreground">
                    {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground max-w-md truncate">
                    {r.notes ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Tile({
  label,
  credits,
  calls,
  subtitle,
}: {
  label: string;
  credits: number;
  calls: number;
  subtitle?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {credits.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">
        {calls.toLocaleString()} calls
        {subtitle ? ` · ${subtitle}` : ""}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-lg border border-border overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function Empty() {
  return (
    <div className="px-3 py-8 text-center text-sm text-muted-foreground">
      No data yet.
    </div>
  );
}
