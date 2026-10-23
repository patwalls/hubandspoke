import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireFeature } from "@/lib/auth-guards";

/** Turn your own My Work morning email on or off (my-day M4). */
export async function PATCH(req: Request) {
  const guard = await requireFeature("myWorkDigest");
  if (guard.response) return guard.response;
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  await db
    .update(users)
    .set({ myWorkDigestEnabled: body.enabled })
    .where(eq(users.id, guard.session.user.id));
  return NextResponse.json({ enabled: body.enabled });
}
