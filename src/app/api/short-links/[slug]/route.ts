import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  deleteShortLink,
  getShortLink,
  ShortLinksApiError,
  updateShortLink,
} from "@/lib/services/short-links";

export const dynamic = "force-dynamic";

async function requireUser() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { session };
}

function handleApiError(err: unknown) {
  if (err instanceof ShortLinksApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[short-links proxy]", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    { status: 500 },
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const gate = await requireUser();
  if (gate.error) return gate.error;
  const { slug } = await params;
  try {
    const link = await getShortLink(slug);
    if (!link) return NextResponse.json({ error: "short link not found" }, { status: 404 });
    return NextResponse.json(link);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const gate = await requireUser();
  if (gate.error) return gate.error;
  const { slug } = await params;
  try {
    const body = await request.json();
    const patch: {
      destinationUrl?: string;
      tag?: string | null;
      archived?: boolean;
    } = {};

    if (typeof body?.destinationUrl === "string") {
      const trimmed = body.destinationUrl.trim();
      if (!isHttpsUrl(trimmed)) {
        return NextResponse.json({ error: "destinationUrl must be an https:// URL" }, { status: 400 });
      }
      patch.destinationUrl = trimmed;
    }
    if ("tag" in body) {
      patch.tag = typeof body.tag === "string" ? body.tag.trim() || null : null;
    }
    if (typeof body?.archived === "boolean") {
      patch.archived = body.archived;
    }

    const updated = await updateShortLink(slug, patch);
    return NextResponse.json(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const gate = await requireUser();
  if (gate.error) return gate.error;
  const { slug } = await params;
  try {
    await deleteShortLink(slug);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleApiError(err);
  }
}
