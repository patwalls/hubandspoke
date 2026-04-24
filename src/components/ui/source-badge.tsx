import { cn } from "@/lib/utils";

type SourceType = "original" | "repost" | "cross_post" | "clip" | null | undefined;

const STYLES: Record<
  Exclude<SourceType, null | undefined>,
  { label: string; className: string; title: string }
> = {
  original: {
    label: "Original",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
    title: "Brand-new original content",
  },
  repost: {
    label: "Repost",
    className: "bg-amber-100 text-amber-900 border-amber-200",
    title: "Reposting an existing piece of content",
  },
  cross_post: {
    label: "Cross-post",
    className: "bg-indigo-100 text-indigo-900 border-indigo-200",
    title: "Same content syndicated to a different platform",
  },
  clip: {
    label: "Clip",
    className: "bg-sky-100 text-sky-900 border-sky-200",
    title: "Clip cut from another piece of content",
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
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0",
        style.className,
        className
      )}
      title={style.title}
    >
      {style.label}
    </span>
  );
}
