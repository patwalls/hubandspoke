import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { isAdminNow } from "@/lib/brand-access";
import {
  MAX_ACTIVE_KEYS_PER_USER,
  MAX_KEY_NAME_LENGTH,
  countActiveKeys,
  createApiKey,
  listAllApiKeys,
  listApiKeys,
} from "@/lib/api/keys";

/**
 * GET  /api/api-keys        → the signed-in user's keys (`?all=1` → every key, admins only)
 * POST /api/api-keys        → create a key; the plaintext is in the response ONCE.
 * Personal-only actions: no brand gate (docs/conventions.md → Permissions).
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  const wantAll = request.nextUrl.searchParams.get("all") === "1";
  if (wantAll) {
    if (!(await isAdminNow(guard.session))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ keys: await listAllApiKeys() });
  }
  return NextResponse.json({ keys: await listApiKeys(userId) });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; expires_in_days?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Give the key a name (what will use it, e.g. \"Zapier\")." }, { status: 400 });
  }
  if (name.length > MAX_KEY_NAME_LENGTH) {
    return NextResponse.json({ error: `Name must be ${MAX_KEY_NAME_LENGTH} characters or fewer.` }, { status: 400 });
  }
  let expiresAt: Date | null = null;
  if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== "") {
    const days = Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: "expires_in_days must be a whole number between 1 and 3650." }, { status: 400 });
    }
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }
  if ((await countActiveKeys(userId)) >= MAX_ACTIVE_KEYS_PER_USER) {
    return NextResponse.json(
      { error: `You already have ${MAX_ACTIVE_KEYS_PER_USER} active keys. Revoke one you no longer use first.` },
      { status: 400 },
    );
  }
  const { key, summary } = await createApiKey({ userId, name, expiresAt });
  return NextResponse.json({ key, summary }, { status: 201 });
}
