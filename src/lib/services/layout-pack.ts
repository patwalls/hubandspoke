import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { descriptLayoutPacks } from "@/lib/db/schema";
import type { DescriptLayoutPackRef } from "@/lib/format-skill";

/**
 * Fetch the registry row a format's `descript_layout_pack_id` points at —
 * null in, null out. Kept in its own module (not promote-clip-idea) so
 * worker tasks can import it without dragging in the enqueue → task-index
 * import cycle.
 */
export async function loadLayoutPackRef(
  packId: string | null,
): Promise<DescriptLayoutPackRef | null> {
  if (!packId) return null;
  const [pack] = await db
    .select({
      name: descriptLayoutPacks.name,
      descriptId: descriptLayoutPacks.descriptId,
      pageUrl: descriptLayoutPacks.pageUrl,
    })
    .from(descriptLayoutPacks)
    .where(eq(descriptLayoutPacks.id, packId))
    .limit(1);
  return pack ?? null;
}
