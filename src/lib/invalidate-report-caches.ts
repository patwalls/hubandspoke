import { revalidateTag } from "next/cache";

// Next.js 16 changed revalidateTag to require a second `profile` arg for
// the new "use cache" system.  The two-arg form only targets "use cache"
// entries with a matching profile and does NOT invalidate unstable_cache
// entries or set pathWasRevalidated (router-cache bust).
// The single-arg form still works correctly for unstable_cache and sets
// pathWasRevalidated.  Cast to bypass the TypeScript overload.
const revalidateByTag = revalidateTag as (tag: string) => void;

export function invalidateReportCaches(): void {
  revalidateByTag("production-report");
  revalidateByTag("content-report");
}
