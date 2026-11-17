import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminNow } from "@/lib/brand-access";
import { getAiSpendSummary } from "@/lib/services/ai-spend";
import { formatCount, formatUsage, formatUsd, providerLabel } from "@/lib/ai-spend-format";

export const metadata: Metadata = { title: "AI spend · Settings" };
export const dynamic = "force-dynamic";

const DAYS = 30;

export default async function AiSpendPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  if (!(await isAdminNow(session))) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 max-w-xl">
        <h2 className="text-base font-semibold text-foreground">Admins only</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Only admins can see what the app spends on AI.
        </p>
      </div>
    );
  }

  const s = await getAiSpendSummary(DAYS);
  const maxDay = Math.max(...s.byDay.map((d) => d.costUsd), 0);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">AI spend</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          What Claude and OpenAI calls cost over the last {DAYS} days, by feature. Estimated from list
          prices and the tokens each call used; the providers&apos; invoices are the final word.
        </p>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="ai-spend-totals">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">Last {DAYS} days</dt>
          <dd className="text-xl font-semibold tabular-nums">{formatUsd(s.totalCostUsd)}</dd>
        </div>
        {["anthropic", "openai"].map((p) => {
          const row = s.byProvider.find((x) => x.provider === p);
          return (
            <div key={p} className="rounded-lg border border-border bg-card px-4 py-3">
              <dt className="text-xs text-muted-foreground">{providerLabel(p)}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatUsd(row?.costUsd ?? 0)}</dd>
            </div>
          );
        })}
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">Calls</dt>
          <dd className="text-xl font-semibold tabular-nums">{formatCount(s.totalCalls)}</dd>
        </div>
      </dl>

      <section>
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">By day</h3>
        <div
          className="flex items-end gap-[3px] h-24 rounded-lg border border-border bg-card px-3 pt-3 pb-2"
          role="img"
          aria-label={`Daily AI spend, last ${DAYS} days`}
        >
          {s.byDay.map((d) => (
            <div
              key={d.day}
              className="flex-1 h-full flex items-end"
              title={`${d.day}: ${formatUsd(d.costUsd)} · ${d.calls} calls`}
            >
              <div
                className="w-full rounded-sm bg-primary/70"
                style={{ height: maxDay > 0 ? `${Math.max((d.costUsd / maxDay) * 100, d.costUsd > 0 ? 3 : 0)}%` : 0 }}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground mt-1 px-1 tabular-nums">
          <span>{s.byDay[0]?.day}</span>
          <span>{s.byDay[s.byDay.length - 1]?.day}</span>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">By feature</h3>
        {s.byFeature.length === 0 ? (
          <p className="text-xs text-muted-foreground">No AI calls recorded in the last {DAYS} days.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Feature</th>
                  <th className="text-left px-3 py-2">Model</th>
                  <th className="text-right px-3 py-2">Calls</th>
                  <th className="text-right px-3 py-2">Usage</th>
                  <th className="text-right px-3 py-2">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {s.byFeature.map((f) => (
                  <tr key={`${f.provider}:${f.feature}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs">{f.feature}</span>
                      <span className="ml-2 text-[11px] text-muted-foreground">{providerLabel(f.provider)}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {f.models.join(", ")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(f.calls)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                      {formatUsage(f)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatUsd(f.costUsd)}
                      {f.unpricedCalls > 0 && (
                        <span
                          className="ml-1 text-muted-foreground"
                          title={`${f.unpricedCalls} calls use a model without a price yet; not in this total`}
                        >
                          +?
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.unpricedModels.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            No price yet for {s.unpricedModels.join(", ")}: their calls count, their cost isn&apos;t in the
            totals (add them to <code className="text-[11px]">src/lib/llm/prices.ts</code>).
          </p>
        )}
      </section>
    </div>
  );
}
