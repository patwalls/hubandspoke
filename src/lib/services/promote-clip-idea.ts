import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas } from "@/lib/db/schema";

export async function killClipIdea(args: {
  clipIdeaId: string;
  killReason: string | null;
  decidedByUserId: string;
}): Promise<void> {
  await db
    .update(clipIdeas)
    .set({
      status: "killed",
      killReason: args.killReason,
      decidedAt: new Date(),
      decidedByUserId: args.decidedByUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));
}
