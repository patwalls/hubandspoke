import { NextResponse } from "next/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

// Everyone in the users table is assignable — including Notion-synced accounts
// that haven't logged in yet. Assignment emails still reach them, and they're
// expected to be onboarding to Hub & Spoke anyway.
//
// Sorted by editor-assignment count (desc) so heavy editors sit at the top
// of every picker and rarely-used accounts fall out of view. Name is the
// stable tiebreaker so the order is deterministic when counts tie.
// Counts only live (non-deleted) rows — soft-deleted history shouldn't
// keep an editor floating at the top.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assignmentCount = sql<number>`count(${productionItems.id})`.as(
    "assignment_count",
  );

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      assignmentCount,
    })
    .from(users)
    .leftJoin(
      productionItems,
      and(
        eq(productionItems.editorUserId, users.id),
        isNull(productionItems.deletedAt),
      ),
    )
    .groupBy(users.id, users.email, users.name, users.avatarUrl)
    .orderBy(desc(assignmentCount), asc(users.name), asc(users.email));

  return NextResponse.json({ users: rows });
}
