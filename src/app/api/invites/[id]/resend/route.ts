import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invites } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { generateToken, hashToken } from "@/lib/tokens";
import { sendInviteEmail } from "@/lib/email";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const { session } = guard;

  const { id } = await params;

  try {
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }
    if (row.acceptedAt) {
      return NextResponse.json(
        { error: "Invite has already been accepted" },
        { status: 409 }
      );
    }
    if (row.revokedAt) {
      return NextResponse.json(
        { error: "Invite has been revoked" },
        { status: 409 }
      );
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    await db
      .update(invites)
      .set({ tokenHash, expiresAt })
      .where(eq(invites.id, id));

    const baseUrl =
      process.env.NEXTAUTH_URL ||
      `${request.nextUrl.protocol}//${request.nextUrl.host}`;
    const inviteUrl = `${baseUrl}/accept-invite?token=${rawToken}`;

    try {
      await sendInviteEmail({
        to: row.email,
        inviteUrl,
        inviterName: session.user.name,
        inviterEmail: session.user.email || "",
        role: row.role,
        expiresAt,
      });
    } catch (err) {
      console.error("Failed to resend invite email:", err);
      return NextResponse.json(
        { error: "Failed to send email" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, expiresAt });
  } catch (error) {
    console.error("Error resending invite:", error);
    return NextResponse.json(
      { error: "Failed to resend invite" },
      { status: 500 }
    );
  }
}
