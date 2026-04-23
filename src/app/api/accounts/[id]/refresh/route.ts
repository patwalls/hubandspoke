import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { enqueue } from "@/jobs/enqueue";
import { getAccountById } from "@/lib/db/accounts";
import { refreshAccount } from "@/lib/services/account-refresh";

/**
 * Refresh an account's SC metadata. Two modes:
 *   - ?mode=sync (default): run the refresh inline so the UI can show
 *     the updated row immediately. Fine for a single manual click.
 *   - ?mode=async: enqueue a graphile-worker job. Use for bulk or slow
 *     endpoints where we don't want to block the request.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const account = await getAccountById(id);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const mode = request.nextUrl.searchParams.get("mode") ?? "sync";
  if (mode === "async") {
    await enqueue("account-refresh", { accountId: id });
    return NextResponse.json({ queued: true });
  }

  try {
    await refreshAccount(id);
    const updated = await getAccountById(id);
    return NextResponse.json({ account: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
