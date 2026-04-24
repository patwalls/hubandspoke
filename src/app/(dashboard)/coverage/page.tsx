import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getCoverageMap,
  getHookSourceBreakdown,
  getVelocityCoverage,
  type CoverageRow,
  type HookSourceBreakdown,
  type VelocityCoverageRow,
} from "@/lib/db/queries";
import { getBrands } from "@/lib/db/brands";
import { VELOCITY_CHECKPOINTS } from "@/lib/velocity-checkpoints";

export const metadata: Metadata = { title: "Coverage" };
export const dynamic = "force-dynamic";

const SIGNAL_COLUMNS: Array<{ key: keyof CoverageRow; label: string }> = [
  { key: "hasTranscript", label: "Transcript" },
  { key: "hasEnrichment", label: "Enrichment" },
  { key: "hasPerfSync", label: "Perf sync" },
  { key: "hasMedia", label: "Media" },
  { key: "hasAuthor", label: "Author" },
  { key: "hasHook", label: "Hook" },
  { key: "hasClipIdeas", label: "Clip ideas" },
  { key: "hasEvergreen", label: "Evergreen" },
];

function fmtCell(count: number, total: number): {
  text: string;
  className: string;
} {
  if (total === 0) return { text: "—", className: "text-muted-foreground" };
  const pct = Math.round((count / total) * 100);
  const text = `${count.toLocaleString()} (${pct}%)`;
  if (pct >= 95) return { text, className: "text-muted-foreground" };
  if (pct >= 50) return { text, className: "text-amber-600" };
  return { text, className: "text-red-600 font-medium" };
}

function brandLabel(slug: string, labels: Map<string, string>): string {
  return labels.get(slug) ?? slug;
}

function sumRows(rows: CoverageRow[]): CoverageRow {
  const sum = {
    brand: "",
    platform: "all",
    total: 0,
    hasTranscript: 0,
    hasEnrichment: 0,
    hasPerfSync: 0,
    hasMedia: 0,
    hasAuthor: 0,
    hasHook: 0,
    hasClipIdeas: 0,
    hasEvergreen: 0,
  };
  for (const r of rows) {
    sum.total += r.total;
    sum.hasTranscript += r.hasTranscript;
    sum.hasEnrichment += r.hasEnrichment;
    sum.hasPerfSync += r.hasPerfSync;
    sum.hasMedia += r.hasMedia;
    sum.hasAuthor += r.hasAuthor;
    sum.hasHook += r.hasHook;
    sum.hasClipIdeas += r.hasClipIdeas;
    sum.hasEvergreen += r.hasEvergreen;
  }
  return sum;
}

const HOOK_SOURCE_LABELS: Array<{
  key: keyof HookSourceBreakdown["bySource"];
  label: string;
}> = [
  { key: "clip_idea", label: "Clip idea" },
  { key: "llm", label: "LLM" },
  { key: "vision", label: "Vision" },
  { key: "content_body", label: "Post body" },
  { key: "title", label: "Title" },
  { key: "manual", label: "Manual" },
  { key: "other", label: "Other" },
];

export default async function CoveragePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [rows, hookBreakdown, velocity] = await Promise.all([
    getCoverageMap(),
    getHookSourceBreakdown(),
    getVelocityCoverage(),
  ]);
  const byBrand = new Map<string, CoverageRow[]>();
  for (const r of rows) {
    if (!byBrand.has(r.brand)) byBrand.set(r.brand, []);
    byBrand.get(r.brand)!.push(r);
  }
  const brands = Array.from(byBrand.keys()).sort();
  const brandLabels = new Map((await getBrands()).map((b) => [b.slug, b.label]));
  const hookByBrand = new Map(hookBreakdown.map((h) => [h.brand, h]));
  const velocityByBrand = new Map(velocity.map((v) => [v.brand, v]));

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Data coverage
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Fill-rate of durable signals across all published content. Grouped
          by brand and primary platform. Red cells mean most items are missing
          that signal — likely worth a targeted backfill. Refresh to re-query.
        </p>
      </div>

      {brands.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No published items found.
        </p>
      )}

      {brands.map((brand) => {
        const brandRows = byBrand.get(brand)!;
        const total = sumRows(brandRows);
        const hooks = hookByBrand.get(brand);
        return (
          <section key={brand} className="space-y-3">
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
              {brandLabel(brand, brandLabels)}
              <span className="ml-2 text-muted-foreground/70 normal-case">
                ({total.total.toLocaleString()} published)
              </span>
            </h3>
            {velocityByBrand.has(brand) && (
              <VelocitySection row={velocityByBrand.get(brand)!} />
            )}
            {hooks && hooks.total > 0 && (
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
                  <h4 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    Hook sources
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {hooks.withHook.toLocaleString()} / {hooks.total.toLocaleString()} with hook
                    {" "}
                    ({Math.round((hooks.withHook / hooks.total) * 100)}%)
                    <span className="mx-2 text-muted-foreground/50">·</span>
                    {hooks.withCoverDescription.toLocaleString()} / {hooks.total.toLocaleString()} with cover description
                    {" "}
                    ({Math.round((hooks.withCoverDescription / hooks.total) * 100)}%)
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-7 gap-2 text-xs">
                  {HOOK_SOURCE_LABELS.map(({ key, label }) => {
                    const count = hooks.bySource[key];
                    const pct = hooks.withHook
                      ? Math.round((count / hooks.withHook) * 100)
                      : 0;
                    return (
                      <div
                        key={key}
                        className="rounded-md bg-muted/40 px-2 py-1.5"
                      >
                        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          {label}
                        </div>
                        <div className="font-medium">
                          {count.toLocaleString()}
                          {count > 0 && (
                            <span className="ml-1 text-muted-foreground font-normal">
                              ({pct}%)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Platform</th>
                    <th className="text-right px-3 py-2">Items</th>
                    {SIGNAL_COLUMNS.map((c) => (
                      <th key={c.key} className="text-right px-3 py-2">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {brandRows.map((r) => (
                    <tr
                      key={`${brand}-${r.platform}`}
                      className="border-t border-border"
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {r.platform}
                      </td>
                      <td className="text-right px-3 py-2 text-muted-foreground">
                        {r.total.toLocaleString()}
                      </td>
                      {SIGNAL_COLUMNS.map((c) => {
                        const cell = fmtCell(r[c.key] as number, r.total);
                        return (
                          <td
                            key={c.key}
                            className={`text-right px-3 py-2 ${cell.className}`}
                          >
                            {cell.text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-accent/20 font-medium">
                    <td className="px-3 py-2 font-mono text-xs">all</td>
                    <td className="text-right px-3 py-2">
                      {total.total.toLocaleString()}
                    </td>
                    {SIGNAL_COLUMNS.map((c) => {
                      const cell = fmtCell(total[c.key] as number, total.total);
                      return (
                        <td
                          key={c.key}
                          className={`text-right px-3 py-2 ${cell.className}`}
                        >
                          {cell.text}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Signals update on their own schedules: enrichment sweep fires at :20
        past the hour, the hook dispatcher (one Haiku call per item that
        picks the best hook across overlay/transcript/caption/title) at :40,
        performance decay is continuous, transcripts publish via Descript on
        demand.
      </p>
    </div>
  );
}

/**
 * Per-brand velocity-snapshot coverage. One cell per checkpoint showing
 * `captured / expected` among Published originals published in the last
 * 14 days whose checkpoint window has closed. 100% is unrealistic —
 * LinkedIn / YT-Community posts with no early engagement legitimately
 * return no view signal. Anything below ~75% on a given checkpoint is
 * worth investigating (worker outage, SC rate limits, schedule bug).
 */
function VelocitySection({ row }: { row: VelocityCoverageRow }) {
  const hasAnyData = VELOCITY_CHECKPOINTS.some(
    (cp) => (row.checkpoints[cp.key]?.expected ?? 0) > 0
  );
  if (!hasAnyData) return null;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
        <h4 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          Velocity snapshots — capture rate
        </h4>
        <span className="text-xs text-muted-foreground">
          % of expected snapshots landing, per checkpoint (last 14 days)
        </span>
      </div>
      <div className="grid grid-cols-4 md:grid-cols-8 gap-2 text-xs">
        {VELOCITY_CHECKPOINTS.map((cp) => {
          const cell = row.checkpoints[cp.key] ?? {
            expected: 0,
            captured: 0,
          };
          const pct =
            cell.expected > 0
              ? Math.round((cell.captured / cell.expected) * 100)
              : null;
          const className =
            pct == null
              ? "text-muted-foreground/70"
              : pct >= 90
                ? "text-muted-foreground"
                : pct >= 75
                  ? "text-amber-600"
                  : "text-red-600 font-medium";
          return (
            <div key={cp.key} className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                {cp.key}
              </div>
              <div className={`font-medium tabular-nums ${className}`}>
                {pct == null ? "—" : `${pct}%`}
              </div>
              <div className="text-[10px] text-muted-foreground/80 tabular-nums">
                {cell.captured.toLocaleString()} /{" "}
                {cell.expected.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
