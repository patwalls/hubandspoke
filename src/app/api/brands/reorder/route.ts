import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { ids } = (body ?? {}) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "ids must be an array of strings" }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    await Promise.all(
      ids.map((id, index) =>
        tx.update(brands).set({ sortOrder: index }).where(eq(brands.id, id))
      )
    );
  });

  return NextResponse.json({ ok: true });
}
