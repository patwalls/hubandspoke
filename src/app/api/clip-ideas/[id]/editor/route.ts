import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { parseDoc } from "@/lib/clip-editor/doc";
import {
  ClipEditorIdeaNotFoundError,
  ClipEditorUnsupportedSourceError,
  loadClipEditorSession,
} from "@/lib/services/clip-editor/session";
import { saveClipEdit } from "@/lib/services/clip-editor/save";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Open the clip editor on a clip idea (creates its edit doc on first open). */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  try {
    const session = await loadClipEditorSession({
      clipIdeaId: id,
      userId: guard.session.user.id as string,
    });
    return NextResponse.json(session);
  } catch (err) {
    if (err instanceof ClipEditorIdeaNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ClipEditorUnsupportedSourceError) {
      // 422 + a machine-readable reason: the dialog falls back to the
      // classic triage UI instead of showing an error.
      return NextResponse.json(
        { error: err.message, unsupported: err.reason },
        { status: 422 },
      );
    }
    throw err;
  }
}

/** Save the edit document. Body: `{ revision, doc }`. 409 on a stale revision. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as {
    revision?: unknown;
    doc?: unknown;
  } | null;
  if (!body || !Number.isInteger(body.revision)) {
    return NextResponse.json({ error: "revision is required" }, { status: 400 });
  }
  const parsed = parseDoc(body.doc);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await saveClipEdit({
    clipIdeaId: id,
    expectedRevision: body.revision as number,
    doc: parsed.doc,
  });
  if (result.ok) return NextResponse.json({ revision: result.revision });
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "Edit not found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      error: "This clip was changed in another tab. Reload to continue.",
      currentRevision: result.currentRevision,
    },
    { status: 409 },
  );
}
