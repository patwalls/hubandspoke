import { NextResponse } from "next/server";
import { requireSession, type GuardResult } from "@/lib/auth-guards";
import { isAcademyEditor } from "@/lib/academy/editors";

/** API guard: a live (not deactivated) session whose email is on the editor list. */
export async function requireAcademyEditor(): Promise<GuardResult> {
  const guard = await requireSession();
  if (guard.response) return guard;
  if (!isAcademyEditor(guard.session)) {
    return { response: NextResponse.json({ error: "Only Learning Center editors can change this" }, { status: 403 }) };
  }
  return guard;
}
