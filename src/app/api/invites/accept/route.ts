import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invites, users } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";

const GENERIC_ERROR = { error: "Invalid or expired invite" };

export async function POST(request: NextRequest) {
  let body: { token?: unknown; password?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!token) {
    return NextResponse.json(GENERIC_ERROR, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .limit(1);

      if (
        !invite ||
        invite.acceptedAt ||
        invite.revokedAt ||
        invite.expiresAt.getTime() < Date.now()
      ) {
        return { kind: "invalid" as const };
      }

      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${invite.email.toLowerCase()}`)
        .limit(1);

      if (existingUser) {
        return { kind: "user-exists" as const };
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const [created] = await tx
        .insert(users)
        .values({
          email: invite.email,
          passwordHash,
          name: name || null,
          role: invite.role,
          invitedBy: invite.invitedByUserId,
          brandIds: invite.brandIds ?? [],
        })
        .returning({ id: users.id, email: users.email });

      await tx
        .update(invites)
        .set({ acceptedAt: new Date(), acceptedByUserId: created.id })
        .where(eq(invites.id, invite.id));

      return { kind: "ok" as const, email: created.email };
    });

    if (result.kind === "invalid") {
      return NextResponse.json(GENERIC_ERROR, { status: 400 });
    }
    if (result.kind === "user-exists") {
      return NextResponse.json(
        { error: "An account with that email already exists" },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, email: result.email });
  } catch (error) {
    console.error("Error accepting invite:", error);
    return NextResponse.json(
      { error: "Failed to accept invite" },
      { status: 500 }
    );
  }
}
