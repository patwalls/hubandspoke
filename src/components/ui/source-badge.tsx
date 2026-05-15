import { cn } from "@/lib/utils";

type SourceType =
  | "original"
  | "repost"
  | "cross_post"
  | "repurposed"
  | null
  | undefined;

// Source-type is a read-only data attribute (you can't un-cross-post an
// item from this chip), so it belongs in Pattern B: small dim text with a
// palette-colored dot conveying the source-type color. The previous
// solid-pill style was visually loud and inconsistent with the rest of
// the title-area chip system — see content-detail.tsx CHIP_B_BASE.
const STYLES: Record<
  Exclude<SourceType, null | undefined>,
  { label: string; dotClassName: string; title: string }
> = {
  original: {
    label: "Original",
    dotClassName: "bg-emerald-500",
    title: "Brand-new original content",
  },
  repost: {
    label: "Repost",
    dotClassName: "bg-amber-500",
    title: "Same content, same platform (any account) — re-run of an earlier post",
  },
  cross_post: {
    label: "Cross-post",
    dotClassName: "bg-rose-500",
    title: "Same content, different platform from the original",
  },
  repurposed: {
    label: "Repurposed",
    dotClassName: "bg-sky-500",
    title:
      "Derivative of a pillar — clip, short cut, or other format spawned from longer content",
  },
};

export function SourceBadge({
  sourceType,
  className,
}: {
  sourceType: SourceType;
  className?: string;
}) {
  const key = sourceType ?? "original";
  const style = STYLES[key];
  if (!style) return null;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 px-1.5 text-xs text-muted-foreground whitespace-nowrap shrink-0",
        className,
      )}
      title={style.title}
    >
      <span
        className={cn("inline-block size-1.5 rounded-full", style.dotClassName)}
        aria-hidden
      />
      {style.label}
    </span>
  );
}
