import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invites } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";

const GENERIC_ERROR = { error: "Invalid or expired invite" };

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json(GENERIC_ERROR, { status: 404 });
  }

  try {
    const [row] = await db
      .select({
        email: invites.email,
        role: invites.role,
        acceptedAt: invites.acceptedAt,
        revokedAt: invites.revokedAt,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .limit(1);

    if (
      !row ||
      row.acceptedAt ||
      row.revokedAt ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return NextResponse.json(GENERIC_ERROR, { status: 404 });
    }

    return NextResponse.json({ email: row.email, role: row.role });
  } catch (error) {
    console.error("Error validating invite:", error);
    return NextResponse.json(
      { error: "Failed to validate invite" },
      { status: 500 }
    );
  }
}
