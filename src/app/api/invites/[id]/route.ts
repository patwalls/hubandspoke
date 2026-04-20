import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invites } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

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
      return NextResponse.json({ ok: true });
    }

    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error revoking invite:", error);
    return NextResponse.json(
      { error: "Failed to revoke invite" },
      { status: 500 }
    );
  }
}
