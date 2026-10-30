import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { isAdminNow } from "@/lib/brand-access";
import { revokeApiKey } from "@/lib/api/keys";

/** DELETE /api/api-keys/[id] — revoke (soft). Own keys, or any key for admins. */
export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await ctx.params;
  const ok = await revokeApiKey({
    keyId: id,
    userId: guard.session.user.id,
    isAdmin: await isAdminNow(guard.session),
  });
  if (!ok) return NextResponse.json({ error: "Key not found or already revoked." }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
