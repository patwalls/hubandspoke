import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireFeature } from "@/lib/auth-guards";

/** Turn your own Monday winners email on or off (`/winners-email`). */
export async function PATCH(req: Request) {
  const guard = await requireFeature("winnersEmail");
  if (guard.response) return guard.response;
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  await db
    .update(users)
    .set({ winnersEmailEnabled: body.enabled })
    .where(eq(users.id, guard.session.user.id));
  return NextResponse.json({ enabled: body.enabled });
}
