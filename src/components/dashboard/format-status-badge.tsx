import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PROVEN_MIN_ITEMS } from "@/lib/services/format-proven-shared";
import type { FormatProvenStatus } from "@/lib/services/format-proven-shared";

interface Props {
  status: FormatProvenStatus | null | undefined;
  /** When "compact", drops the tooltip + the "X/5 hits" detail.
   *  Used in dense tables where the cell is already narrow. */
  size?: "default" | "compact";
}

export function FormatStatusBadge({ status, size = "default" }: Props) {
  if (!status) return <span className="text-muted-foreground text-xs">—</span>;

  const compact = size === "compact";

  if (status.reason === "proven") {
    return (
      <StatusWithTooltip status={status} disabled={compact}>
        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
          Proven
        </Badge>
      </StatusWithTooltip>
    );
  }

  if (status.reason === "stale") {
    return (
      <StatusWithTooltip status={status} disabled={compact}>
        <Badge variant="outline" className="text-muted-foreground">
          Stale
        </Badge>
      </StatusWithTooltip>
    );
  }

  // testing — show progress to proven so editors know what's missing
  const missingItems = Math.max(0, PROVEN_MIN_ITEMS - status.itemCount);
  const itemsLabel = compact
    ? `Testing`
    : missingItems > 0
      ? `Testing · ${status.itemCount}/${PROVEN_MIN_ITEMS} items`
      : status.hitCount === 0
        ? `Testing · no hit yet`
        : `Testing`;
  return (
    <StatusWithTooltip status={status} disabled={compact}>
      <Badge variant="outline" className="text-foreground">
        {itemsLabel}
      </Badge>
    </StatusWithTooltip>
  );
}

function StatusWithTooltip({
  status,
  disabled,
  children,
}: {
  status: FormatProvenStatus;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        className="focus:outline-none cursor-help"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 text-xs leading-relaxed space-y-1"
        side="top"
      >
        <p className="font-medium text-foreground">
          {labelForReason(status.reason)}
        </p>
        <p>
          Last 180 days: {status.itemCount} item
          {status.itemCount === 1 ? "" : "s"} ({status.recentItemCount} in
          the last 90).
        </p>
        <p>
          Median views: {status.formatMedian.toLocaleString()} · peer median
          {status.dominantPostType ? ` (${status.dominantPostType})` : ""}:{" "}
          {status.peerMedian.toLocaleString()}.
        </p>
        <p>
          Outlier hits (≥3× peer median): {status.hitCount}.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function labelForReason(reason: FormatProvenStatus["reason"]): string {
  switch (reason) {
    case "proven":
      return "Proven format";
    case "testing":
      return "In testing";
    case "stale":
      return "No recent activity";
  }
}
