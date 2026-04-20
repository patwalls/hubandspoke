import { NextResponse } from "next/server";
import { asc, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

// Returns the list of users who can be picked as producer/editor — i.e. anyone
// who has accepted an invite (passwordHash set). Notion-synced contractors
// without an account are intentionally excluded so assignments only land on
// people who can log in and see their work.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(isNotNull(users.passwordHash))
    .orderBy(asc(users.name));

  return NextResponse.json({ users: rows });
}
