import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { parseDesignDoc } from "@/lib/design-editor/doc";
import {
  DesignItemNotFoundError,
  DesignUnsupportedError,
  loadDesignEditorSession,
} from "@/lib/services/design-editor/session";
import { saveDesignDoc } from "@/lib/services/design-editor/save";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Open the design editor (drafts the post with AI on first open — allow
 *  ~20s). 422 with `unsupported` → the dialog falls back to the classic UI. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  try {
    return NextResponse.json(await loadDesignEditorSession({ productionItemId: id, userId: guard.session.user.id as string }));
  } catch (err) {
    if (err instanceof DesignItemNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof DesignUnsupportedError) {
      return NextResponse.json({ error: err.message, unsupported: err.reason }, { status: 422 });
    }
    throw err;
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { revision?: unknown; doc?: unknown } | null;
  if (!body || !Number.isInteger(body.revision)) return NextResponse.json({ error: "revision is required" }, { status: 400 });
  const parsed = parseDesignDoc(body.doc);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await saveDesignDoc({ productionItemId: id, expectedRevision: body.revision as number, doc: parsed.doc });
  if (result.ok) return NextResponse.json({ revision: result.revision });
  if (result.reason === "not_found") return NextResponse.json({ error: "Design not found" }, { status: 404 });
  return NextResponse.json({ error: "This design was changed in another tab. Reload to continue.", currentRevision: result.currentRevision }, { status: 409 });
}
