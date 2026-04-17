import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  createDescriptProjectFromUrl,
  toGoogleDriveDirectUrl,
} from "@/lib/descript";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { url?: string; projectName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawUrl = body.url?.trim();
  const projectName = body.projectName?.trim() || "Imported video";
  if (!rawUrl) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const mediaUrl = toGoogleDriveDirectUrl(rawUrl);

  try {
    const result = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl,
    });
    return NextResponse.json({
      projectUrl: result.project_url,
      projectId: result.project_id,
      jobId: result.job_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
