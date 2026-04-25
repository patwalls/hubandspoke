import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

export async function GET() {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        avatarUrl: users.avatarUrl,
        invitedBy: users.invitedBy,
        createdAt: users.createdAt,
        dailyScorecardEmailEnabled: users.dailyScorecardEmailEnabled,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    return NextResponse.json({ users: rows });
  } catch (error) {
    console.error("Error fetching users:", error);
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}
