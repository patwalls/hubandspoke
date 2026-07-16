import { cn } from "@/lib/utils";

type BadgeType = "viral" | "trending" | "outlier";

interface PerformanceBadgeProps {
  badge: BadgeType | null;
  multiplier: number;
}

const BADGE_CONFIG: Record<BadgeType, { label: string; emoji: string; className: string }> = {
  viral: {
    label: "Viral",
    emoji: "🔥",
    className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  },
  trending: {
    label: "Trending",
    emoji: "🚀",
    className: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-400",
  },
  outlier: {
    label: "Outlier",
    emoji: "⭐",
    className: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  },
};

export function PerformanceBadge({ badge, multiplier }: PerformanceBadgeProps) {
  if (!badge) return null;
  const config = BADGE_CONFIG[badge];

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
          config.className
        )}
      >
        {config.emoji} {config.label}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {multiplier.toFixed(1)}x average
      </span>
    </div>
  );
}
