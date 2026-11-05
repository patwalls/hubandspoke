import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { academyProgress, academyVideos } from "@/lib/db/schema";
import { progressSchema } from "@/lib/academy/validate";

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/**
 * PUT /api/academy/progress/[videoId] — the signed-in user's own progress on
 * a video. Body: { checkedItems?: string[], completed?: boolean }. Only
 * items that are on the video's current checklist are kept.
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { videoId } = await context.params;

  const parsed = progressSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid progress" }, { status: 400 });

  const [video] = await db
    .select({ actionItems: academyVideos.actionItems })
    .from(academyVideos)
    .where(eq(academyVideos.id, videoId));
  if (!video) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const set: Partial<typeof academyProgress.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.checkedItems) {
    const valid = new Set(video.actionItems ?? []);
    set.checkedItems = [...new Set(parsed.data.checkedItems)].filter((t) => valid.has(t));
  }
  if (parsed.data.completed !== undefined) {
    set.completedAt = parsed.data.completed ? new Date() : null;
  }

  await db
    .insert(academyProgress)
    .values({ userId, videoId, checkedItems: set.checkedItems ?? [], completedAt: set.completedAt ?? null })
    .onConflictDoUpdate({ target: [academyProgress.userId, academyProgress.videoId], set });

  return NextResponse.json({ ok: true });
}
