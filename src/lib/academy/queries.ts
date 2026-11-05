import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academyCategories, academyProgress, academyVideos, type AcademyLearnPoint } from "@/lib/db/schema";

export type AcademyVideo = {
  id: string;
  categoryId: string;
  slug: string;
  title: string;
  summary: string | null;
  videoUrl: string | null;
  durationLabel: string | null;
  learnPoints: AcademyLearnPoint[];
  actionItems: string[];
  notes: string | null;
  /** Listed but not watchable yet. */
  comingSoon: boolean;
  /** Became watchable within the last NEW_FOR_DAYS days. */
  isNew: boolean;
};

/** How long a newly added (or newly un-"coming soon") video shows "New". */
export const NEW_FOR_DAYS = 14;

export type AcademyCategory = {
  id: string;
  name: string;
  description: string | null;
  videos: AcademyVideo[];
};

/** Per-video progress for one user, keyed by video id. */
export type AcademyProgressMap = Record<string, { checkedItems: string[]; completed: boolean }>;

/** Every category (in order) with its videos (in order). */
export async function getAcademyLibrary(): Promise<AcademyCategory[]> {
  const newSince = Date.now() - NEW_FOR_DAYS * 24 * 60 * 60 * 1000;
  const [cats, vids] = await Promise.all([
    db.select().from(academyCategories).orderBy(asc(academyCategories.sortOrder), asc(academyCategories.createdAt)),
    db.select().from(academyVideos).orderBy(asc(academyVideos.sortOrder), asc(academyVideos.createdAt)),
  ]);
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    videos: vids
      .filter((v) => v.categoryId === c.id)
      .map((v) => ({
        id: v.id,
        categoryId: v.categoryId,
        slug: v.slug,
        title: v.title,
        summary: v.summary,
        videoUrl: v.videoUrl,
        durationLabel: v.durationLabel,
        learnPoints: v.learnPoints ?? [],
        actionItems: v.actionItems ?? [],
        notes: v.notes,
        comingSoon: v.comingSoon,
        isNew: !v.comingSoon && v.availableAt !== null && v.availableAt.getTime() >= newSince,
      })),
  }));
}

export async function getAcademyProgress(userId: string): Promise<AcademyProgressMap> {
  const rows = await db.select().from(academyProgress).where(eq(academyProgress.userId, userId));
  const map: AcademyProgressMap = {};
  for (const r of rows) {
    map[r.videoId] = { checkedItems: r.checkedItems ?? [], completed: r.completedAt !== null };
  }
  return map;
}

/** Videos in library order — drives prev/next on a video page. */
export function flattenVideos(library: AcademyCategory[]): AcademyVideo[] {
  return library.flatMap((c) => c.videos);
}
