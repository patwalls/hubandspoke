import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { invites, users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { isRole } from "@/lib/rbac";
import { generateToken, hashToken } from "@/lib/tokens";
import { sendInviteEmail } from "@/lib/email";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  try {
    const inviter = alias(users, "inviter");
    const rows = await db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        invitedByUserId: invites.invitedByUserId,
        invitedByEmail: inviter.email,
        invitedByName: inviter.name,
        expiresAt: invites.expiresAt,
        acceptedAt: invites.acceptedAt,
        revokedAt: invites.revokedAt,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .leftJoin(inviter, eq(invites.invitedByUserId, inviter.id))
      .orderBy(desc(invites.createdAt));

    const now = Date.now();
    const withStatus = rows.map((r) => {
      let status: "accepted" | "revoked" | "expired" | "pending";
      if (r.acceptedAt) status = "accepted";
      else if (r.revokedAt) status = "revoked";
      else if (r.expiresAt.getTime() < now) status = "expired";
      else status = "pending";
      return { ...r, status };
    });

    return NextResponse.json({ invites: withStatus });
  } catch (error) {
    console.error("Error fetching invites:", error);
    return NextResponse.json(
      { error: "Failed to fetch invites" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const { session } = guard;

  let body: { email?: unknown; role?: unknown; brandIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = rawEmail.toLowerCase().trim();
  if (!email || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const role = body.role;
  if (!isRole(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const brandIds =
    Array.isArray(body.brandIds) &&
    body.brandIds.every((id) => typeof id === "string")
      ? (body.brandIds as string[])
      : [];

  try {
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existingUser) {
      return NextResponse.json(
        { error: "A user with that email already exists" },
        { status: 409 }
      );
    }

    // Revoke any pending invites for the same email so there's only one
    // live token at a time.
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          sql`lower(${invites.email}) = ${email}`,
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt)
        )
      );

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const [created] = await db
      .insert(invites)
      .values({
        email,
        role,
        invitedByUserId: session.user.id,
        tokenHash,
        expiresAt,
        brandIds,
      })
      .returning();

    const baseUrl =
      process.env.NEXTAUTH_URL ||
      `${request.nextUrl.protocol}//${request.nextUrl.host}`;
    const inviteUrl = `${baseUrl}/accept-invite?token=${rawToken}`;

    try {
      await sendInviteEmail({
        to: email,
        inviteUrl,
        inviterName: session.user.name,
        inviterEmail: session.user.email || "",
        role,
        expiresAt,
      });
    } catch (err) {
      console.error("Failed to send invite email:", err);
      return NextResponse.json(
        { error: "Invite created but failed to send email" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      id: created.id,
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt,
    });
  } catch (error) {
    console.error("Error creating invite:", error);
    return NextResponse.json(
      { error: "Failed to create invite" },
      { status: 500 }
    );
  }
}
