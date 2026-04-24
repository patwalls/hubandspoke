"use client";

import { useState } from "react";

// Point on the sparkline. `postAgeMinutes` drives the X position so the
// shape reflects the real gap between snapshots (not just row order), and
// `checkpointKey` is shown in the tooltip when present.
export interface ViewHistoryPoint {
  takenAt: string;
  views: number;
  postAgeMinutes: number;
  checkpointKey: string | null;
}

interface Props {
  points: ViewHistoryPoint[];
  /** Height in px. Default is intentionally small — this is meta-info, not the hero. */
  height?: number;
  /** Width in px. Flexes within the caller's column; 160 works inside the stats card. */
  width?: number;
}

/**
 * Minimal SVG sparkline for the view-over-time snapshots on an item. No
 * axes, no labels — the hover tooltip surfaces exact values. Deliberately
 * muted so it reads as "secondary info" next to the big views number.
 */
export function ViewsSparkline({ points, height = 28, width = 160 }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length < 2) return null;

  const PAD_X = 2;
  const PAD_Y = 3;
  const innerW = width - PAD_X * 2;
  const innerH = height - PAD_Y * 2;

  const xs = points.map((p) => p.postAgeMinutes);
  const ys = points.map((p) => p.views);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const coords = points.map((p) => {
    const x = PAD_X + ((p.postAgeMinutes - xMin) / xRange) * innerW;
    // SVG y grows downward; invert so "more views" goes up.
    const y = PAD_Y + innerH - ((p.views - yMin) / yRange) * innerH;
    return { x, y };
  });

  const pathD = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");

  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${(
    height - PAD_Y
  ).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(height - PAD_Y).toFixed(1)} Z`;

  const hoverPoint = hoverIndex != null ? points[hoverIndex] : null;
  const hoverCoord = hoverIndex != null ? coords[hoverIndex] : null;

  return (
    <div className="relative inline-block">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block"
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Filled area under the line — very light tint. */}
        <path d={areaD} fill="currentColor" className="text-foreground/5" />
        {/* The line itself. */}
        <path
          d={pathD}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground"
        />
        {/* Dots for each snapshot. Larger on hover. */}
        {coords.map((c, i) => (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={hoverIndex === i ? 2.8 : 1.8}
            fill="currentColor"
            className={
              hoverIndex === i ? "text-foreground" : "text-muted-foreground"
            }
          />
        ))}
        {/* Invisible hover regions — one vertical band per point. */}
        {coords.map((c, i) => {
          const prevX = i === 0 ? PAD_X : (coords[i - 1].x + c.x) / 2;
          const nextX =
            i === coords.length - 1
              ? width - PAD_X
              : (c.x + coords[i + 1].x) / 2;
          return (
            <rect
              key={`hit-${i}`}
              x={prevX}
              y={0}
              width={Math.max(1, nextX - prevX)}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHoverIndex(i)}
            />
          );
        })}
      </svg>
      {hoverPoint && hoverCoord && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-1 text-[10px] leading-tight text-foreground shadow-sm"
          style={{
            left: hoverCoord.x,
            top: Math.max(0, hoverCoord.y - 32),
          }}
        >
          <div className="tabular-nums font-medium">
            {hoverPoint.views.toLocaleString()} views
          </div>
          <div className="text-muted-foreground">
            {labelForPoint(hoverPoint)}
          </div>
        </div>
      )}
    </div>
  );
}

// Human-readable labels for each of the 5 scheduled checkpoint keys. Kept
// in sync with VELOCITY_CHECKPOINTS in src/jobs/tasks/capture-velocity-snapshot.ts.
const CHECKPOINT_LABELS: Record<string, string> = {
  "15m": "First 15 minutes",
  "30m": "First 30 minutes",
  "1h": "First hour",
  "2h": "First 2 hours",
  "4h": "First 4 hours",
};

function labelForPoint(p: ViewHistoryPoint): string {
  if (p.checkpointKey && CHECKPOINT_LABELS[p.checkpointKey]) {
    return CHECKPOINT_LABELS[p.checkpointKey];
  }
  // Legacy untagged snapshot (pre per-post-scheduled architecture). Fall
  // back to a precise age description.
  return `After ${formatAgePrecise(p.postAgeMinutes)}`;
}

function formatAgePrecise(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) {
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}
