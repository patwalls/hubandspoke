"use client";

import { useMemo, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Period } from "@/types";
import { periodTrend, type Trend } from "@/lib/period-chart";
import { cn } from "@/lib/utils";

/** The chart views PeriodTable can swap its table for. */
export type ChartView = "lines" | "multiples" | "stacked";

export interface ChartSeries {
  key: string;
  label: string;
  icon?: ReactNode;
  /** One value per period, aligned with `periods`. */
  values: number[];
  total: number;
  /** A CSS colour (a --viz-N token) — assigned by the caller in fixed slot
   *  order so a series keeps its colour across views and metric tabs. */
  color: string;
}

interface PeriodChartProps {
  view: ChartView;
  series: ChartSeries[];
  periods: Period[];
  /** Index of the still-filling period (drawn dashed / faded), or null. */
  partialIndex: number | null;
  /** Per-period totals across every row, for the tooltip footer. Omitted
   *  for ratio metrics (views per post) where a sum means nothing. */
  periodTotals?: number[];
  formatValue: (v: number) => string;
}

export function formatPeriodRange(p: Period): string {
  const s = new Date(p.start + "T00:00:00");
  const e = new Date(p.end + "T00:00:00");
  if (p.start === p.end) return format(s, "EEEE, MMMM do, yyyy");
  return `${format(s, "EEEE, MMMM do")} to ${format(e, "EEEE, MMMM do")}`;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10 };
const CHART_HEIGHT = 320;

export function PeriodChart(props: PeriodChartProps) {
  if (props.view === "multiples") return <SmallMultiples {...props} />;
  return <SeriesChart {...props} />;
}

// ── Lines + stacked bars ──────────────────────────────────────────────────
// One plot, a legend above it that doubles as a show/hide toggle per series.

function SeriesChart({
  view,
  series,
  periods,
  partialIndex,
  periodTotals,
  formatValue,
}: PeriodChartProps) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const visible = series.filter((s) => !hidden.has(s.key));

  // Recharts reads dataKey as a property path, so series are keyed by index
  // (`s0`, `s0p`) rather than by label — labels carry dots and "@".
  // `sNp` holds only the last complete point + the partial one, so the
  // in-progress stretch can be drawn as its own dashed segment.
  const rows = useMemo(
    () =>
      periods.map((p, i) => {
        const row: Record<string, number | string | null> = { label: p.label, i };
        series.forEach((s, n) => {
          const v = s.values[i] ?? 0;
          row[`s${n}`] = partialIndex === i && view === "lines" ? null : v;
          if (partialIndex !== null) {
            row[`s${n}p`] = i >= partialIndex - 1 ? v : null;
          }
        });
        return row;
      }),
    [periods, series, partialIndex, view],
  );

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      // Never hide the last one — an empty plot reads as "no data".
      else if (next.size < series.length - 1) next.add(key);
      return next;
    });

  const tooltip = (
    <Tooltip
      cursor={
        view === "lines"
          ? { stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "3 3" }
          : { fill: "var(--accent)", opacity: 0.5 }
      }
      isAnimationActive={false}
      content={({ active, payload }) => {
        const i = payload?.[0]?.payload?.i as number | undefined;
        if (!active || i === undefined) return null;
        return (
          <ChartTooltip
            period={periods[i]}
            partial={i === partialIndex}
            entries={visible.map((s) => ({
              key: s.key,
              label: s.label,
              color: s.color,
              value: s.values[i] ?? 0,
            }))}
            total={periodTotals?.[i]}
            formatValue={formatValue}
          />
        );
      }}
    />
  );

  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tick={AXIS_TICK}
        interval="preserveStartEnd"
        minTickGap={8}
        dy={4}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tick={AXIS_TICK}
        width={44}
        allowDecimals={false}
        tickFormatter={(v: number) => compact.format(v)}
      />
    </>
  );

  return (
    <div className="px-3 sm:px-5 pt-4 pb-3">
      <Legend series={series} hidden={hidden} onToggle={toggle} formatValue={formatValue} />
      <div style={{ height: CHART_HEIGHT }} className="mt-3 -ml-2">
        <ResponsiveContainer width="100%" height="100%">
          {view === "lines" ? (
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              {axes}
              {tooltip}
              {series.flatMap((s, n) =>
                hidden.has(s.key)
                  ? []
                  : [
                      <Line
                        key={`s${n}`}
                        dataKey={`s${n}`}
                        stroke={s.color}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                        isAnimationActive={false}
                        connectNulls={false}
                      />,
                      partialIndex !== null && (
                        <Line
                          key={`s${n}p`}
                          dataKey={`s${n}p`}
                          stroke={s.color}
                          strokeWidth={2}
                          strokeDasharray="3 4"
                          strokeOpacity={0.7}
                          dot={false}
                          activeDot={false}
                          isAnimationActive={false}
                          legendType="none"
                        />
                      ),
                    ],
              )}
            </LineChart>
          ) : (
            <BarChart
              data={rows}
              margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
              barCategoryGap="22%"
            >
              {axes}
              {tooltip}
              {series.map((s, n) => {
                if (hidden.has(s.key)) return null;
                const isTop = s.key === visible[visible.length - 1]?.key;
                return (
                  <Bar
                    key={`s${n}`}
                    dataKey={`s${n}`}
                    stackId="a"
                    fill={s.color}
                    // The 2px card-coloured stroke is the gap between segments.
                    stroke="var(--card)"
                    strokeWidth={2}
                    radius={isTop ? [4, 4, 0, 0] : 0}
                    isAnimationActive={false}
                  >
                    {rows.map((_, i) => (
                      <Cell key={i} fillOpacity={i === partialIndex ? 0.4 : 1} />
                    ))}
                  </Bar>
                );
              })}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {partialIndex !== null && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {view === "lines" ? "Dashed" : "Faded"}: {periods[partialIndex].label} is still in
          progress.
        </p>
      )}
    </div>
  );
}

function Legend({
  series,
  hidden,
  onToggle,
  formatValue,
}: {
  series: ChartSeries[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  formatValue: (v: number) => string;
}) {
  return (
    <div className="flex flex-wrap gap-x-1 gap-y-1">
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!off}
            title={off ? `Show ${s.label}` : `Hide ${s.label}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent",
              off && "opacity-40",
            )}
          >
            <span
              className="size-2.5 rounded-[3px] shrink-0"
              style={{ background: off ? "transparent" : s.color, boxShadow: `inset 0 0 0 1.5px ${s.color}` }}
            />
            {s.icon}
            <span className="font-medium text-foreground">{s.label}</span>
            <span className="tabular-nums text-muted-foreground">{formatValue(s.total)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChartTooltip({
  period,
  partial,
  entries,
  total,
  formatValue,
}: {
  period: Period;
  partial: boolean;
  entries: { key: string; label: string; color: string; value: number }[];
  total?: number;
  formatValue: (v: number) => string;
}) {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  return (
    <div className="min-w-[200px] rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-foreground">{period.label}</span>
        {partial && <span className="text-[10px] text-muted-foreground">in progress</span>}
      </div>
      <div className="mb-1.5 text-[11px] text-muted-foreground">{formatPeriodRange(period)}</div>
      <div className="space-y-0.5">
        {sorted.map((e) => (
          <div key={e.key} className="flex items-center gap-2">
            <span className="size-2 rounded-[2px] shrink-0" style={{ background: e.color }} />
            <span className="flex-1 truncate text-muted-foreground">{e.label}</span>
            <span className="tabular-nums font-medium text-foreground">{formatValue(e.value)}</span>
          </div>
        ))}
      </div>
      {total !== undefined && (
        <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5">
          <span className="text-muted-foreground">Total</span>
          <span className="tabular-nums font-semibold text-foreground">{formatValue(total)}</span>
        </div>
      )}
    </div>
  );
}

// ── Small multiples ───────────────────────────────────────────────────────
// One tile per series, each on its own scale so a small brand's trend is as
// readable as a big one's. Biggest first; the chip answers "is it growing?".

function SmallMultiples({ series, periods, partialIndex, formatValue }: PeriodChartProps) {
  const tiles = useMemo(
    () => [...series].sort((a, b) => b.total - a.total),
    [series],
  );
  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
      {tiles.map((s) => (
        <MultipleTile
          key={s.key}
          series={s}
          periods={periods}
          partialIndex={partialIndex}
          formatValue={formatValue}
        />
      ))}
    </div>
  );
}

function MultipleTile({
  series,
  periods,
  partialIndex,
  formatValue,
}: {
  series: ChartSeries;
  periods: Period[];
  partialIndex: number | null;
  formatValue: (v: number) => string;
}) {
  const trend = periodTrend(series.values, partialIndex);
  const rows = periods.map((p, i) => {
    const v = series.values[i] ?? 0;
    return {
      label: p.label,
      i,
      v: partialIndex === i ? null : v,
      p: partialIndex !== null && i >= partialIndex - 1 ? v : null,
    };
  });
  return (
    <div className="rounded-md border border-border/70 px-3 pt-2.5 pb-1">
      <div className="flex items-center gap-2">
        {series.icon}
        <span className="truncate text-sm font-semibold text-foreground">{series.label}</span>
        <span className="ml-auto shrink-0">
          <TrendChip trend={trend} />
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
        {formatValue(series.total)} total
      </div>
      <div className="h-20 -mx-1 mt-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 6, right: 4, bottom: 2, left: 4 }}>
            <YAxis hide domain={[0, "dataMax"]} />
            <XAxis dataKey="label" hide />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "3 3" }}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const i = payload?.[0]?.payload?.i as number | undefined;
                if (!active || i === undefined) return null;
                return (
                  <div className="rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-md">
                    <span className="text-muted-foreground">{periods[i].label}</span>{" "}
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatValue(series.values[i] ?? 0)}
                    </span>
                    {i === partialIndex && (
                      <span className="text-muted-foreground"> · so far</span>
                    )}
                  </div>
                );
              }}
            />
            <Line
              dataKey="v"
              stroke={series.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5, stroke: "var(--card)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {partialIndex !== null && (
              <Line
                dataKey="p"
                stroke={series.color}
                strokeWidth={2}
                strokeDasharray="3 4"
                strokeOpacity={0.7}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TrendChip({ trend }: { trend: Trend }) {
  if (!trend) return null;
  const base =
    "inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums";
  const span = `last ${trend.window} vs the ${trend.window} before (complete periods only)`;
  const up =
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900";
  if (trend.kind === "new") {
    return (
      <span className={cn(base, up)} title={span}>
        <ArrowUpRight className="size-3" />
        new
      </span>
    );
  }
  const pct = Math.round(trend.pct * 100);
  const palette =
    pct > 0
      ? up
      : pct < 0
        ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900"
        : "bg-muted text-muted-foreground border-border";
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn(base, palette)} title={span}>
      <Icon className="size-3" />
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}
