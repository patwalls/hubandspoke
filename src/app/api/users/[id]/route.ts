import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { isRole } from "@/lib/rbac";

async function countOtherAdmins(excludeId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), ne(users.id, excludeId)));
  return row?.n ?? 0;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const { session } = guard;

  const { id } = await params;

  let body: {
    role?: unknown;
    dailyScorecardEmailEnabled?: unknown;
    brandIds?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Build the update set from whichever fields are present. At least one
  // valid field is required.
  const update: Partial<typeof users.$inferInsert> = {};
  let nextRole: "admin" | "creator" | undefined;

  if (body.role !== undefined) {
    if (!isRole(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    nextRole = body.role;
    update.role = nextRole;
  }
  if (body.dailyScorecardEmailEnabled !== undefined) {
    if (typeof body.dailyScorecardEmailEnabled !== "boolean") {
      return NextResponse.json(
        { error: "dailyScorecardEmailEnabled must be a boolean" },
        { status: 400 }
      );
    }
    update.dailyScorecardEmailEnabled = body.dailyScorecardEmailEnabled;
  }
  if (body.brandIds !== undefined) {
    if (
      !Array.isArray(body.brandIds) ||
      !body.brandIds.every((id) => typeof id === "string")
    ) {
      return NextResponse.json(
        { error: "brandIds must be an array of strings" },
        { status: 400 }
      );
    }
    update.brandIds = body.brandIds as string[];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No fields to update" },
      { status: 400 }
    );
  }

  try {
    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (nextRole !== undefined) {
      if (target.role === nextRole) {
        // No-op for the role change; other fields below may still apply.
        delete update.role;
      } else {
        if (target.id === session.user.id && nextRole !== "admin") {
          return NextResponse.json(
            { error: "You cannot demote yourself" },
            { status: 409 }
          );
        }
        if (target.role === "admin" && nextRole !== "admin") {
          const others = await countOtherAdmins(target.id);
          if (others === 0) {
            return NextResponse.json(
              { error: "At least one admin is required" },
              { status: 409 }
            );
          }
        }
      }
    }

    if (Object.keys(update).length > 0) {
      await db
        .update(users)
        .set({ ...update, updatedAt: new Date() })
        .where(eq(users.id, id));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const { session } = guard;

  const { id } = await params;

  try {
    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (target.id === session.user.id) {
      return NextResponse.json(
        { error: "You cannot remove yourself" },
        { status: 409 }
      );
    }

    if (target.role === "admin") {
      const others = await countOtherAdmins(target.id);
      if (others === 0) {
        return NextResponse.json(
          { error: "At least one admin is required" },
          { status: 409 }
        );
      }
    }

    await db.delete(users).where(eq(users.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "Failed to delete user" },
      { status: 500 }
    );
  }
}
