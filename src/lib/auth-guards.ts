import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";

export type GuardResult =
  | { session: Session; response?: undefined }
  | { session?: undefined; response: NextResponse };

export async function requireSession(): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { session };
}

export async function requireAdmin(): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (session.user.role !== "admin") {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { session };
}

export function isAdmin(session: Session | null | undefined): boolean {
  return session?.user?.role === "admin";
}
