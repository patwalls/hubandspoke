import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      sourceType: productionItems.sourceType,
      repostedFromItemId: productionItems.repostedFromItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (item.sourceType !== "cross_post") {
    return NextResponse.json({ error: "Item is not a cross-post" }, { status: 400 });
  }
  if (!item.repostedFromItemId) {
    return NextResponse.json({ error: "Cross-post has no source item" }, { status: 400 });
  }

  await enqueue("descript-derivative-create", {
    derivativeItemId: id,
    sourceItemId: item.repostedFromItemId,
    mode: "cross-post",
  });

  return NextResponse.json({ ok: true });
}
