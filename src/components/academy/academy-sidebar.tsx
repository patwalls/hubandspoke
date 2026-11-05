import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcademyCategory, AcademyProgressMap } from "@/lib/academy/queries";
import { VideoBadge } from "@/components/academy/video-badge";

/**
 * Help-center style left nav for the Academy: Home, then each category as a
 * heading with its videos underneath. The current page is a tinted pill;
 * finished videos get a small check.
 */
export function AcademySidebar({
  library,
  progress,
  activeVideoId,
}: {
  library: AcademyCategory[];
  progress: AcademyProgressMap;
  /** null on the Academy home page. */
  activeVideoId: string | null;
}) {
  const item = (active: boolean) =>
    cn(
      "flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-[14px] leading-snug transition-colors",
      active
        ? "bg-orange-100/70 font-medium text-orange-900 dark:bg-orange-950/50 dark:text-orange-200"
        : "text-muted-foreground hover:bg-accent hover:text-foreground",
    );

  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <nav className="sticky top-20 max-h-[calc(100vh-6rem)] space-y-6 overflow-y-auto pb-8 pr-2" aria-label="Academy">
        <div className="space-y-0.5">
          <div className="px-3 pb-1 text-[14px] font-semibold text-foreground">Academy</div>
          <Link href="/academy" aria-current={activeVideoId === null ? "page" : undefined} className={item(activeVideoId === null)}>
            Home
          </Link>
        </div>

        {library.filter((cat) => cat.videos.length > 0).map((cat) => (
          <div key={cat.id} className="space-y-0.5">
            <div className="px-3 pb-1 text-[14px] font-semibold text-foreground">{cat.name}</div>
            {cat.videos.map((v) => {
              const active = v.id === activeVideoId;
              return (
                <Link key={v.id} href={`/academy/${v.slug}`} aria-current={active ? "page" : undefined} className={item(active)}>
                  <span className={cn(v.comingSoon && "opacity-60")}>{v.title}</span>
                  {progress[v.id]?.completed ? (
                    <Check className="size-3.5 shrink-0 text-emerald-600" aria-label="Completed" />
                  ) : (
                    <VideoBadge video={v} />
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
