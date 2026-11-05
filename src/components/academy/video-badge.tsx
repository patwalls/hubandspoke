import { cn } from "@/lib/utils";
import type { AcademyVideo } from "@/lib/academy/queries";

/** "New" / "Coming soon" pill for an Academy video (nothing otherwise). */
export function VideoBadge({ video, className }: { video: Pick<AcademyVideo, "isNew" | "comingSoon">; className?: string }) {
  if (video.comingSoon) {
    return (
      <span className={cn("inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", className)}>
        Coming soon
      </span>
    );
  }
  if (video.isNew) {
    return (
      <span className={cn("inline-flex shrink-0 items-center rounded-full bg-orange-500 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white", className)}>
        New
      </span>
    );
  }
  return null;
}
