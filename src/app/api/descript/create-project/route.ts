import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  createDescriptProjectFromUrl,
  createDescriptProjectForUpload,
  toGoogleDriveDirectUrl,
} from "@/lib/descript";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    mode?: "url" | "upload";
    url?: string;
    projectName?: string;
    fileName?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const projectName = body.projectName?.trim() || "Imported video";
  const mode = body.mode || (body.url ? "url" : "upload");

  try {
    if (mode === "url") {
      const rawUrl = body.url?.trim();
      if (!rawUrl) {
        return NextResponse.json({ error: "url required" }, { status: 400 });
      }
      const result = await createDescriptProjectFromUrl({
        projectName,
        mediaUrl: toGoogleDriveDirectUrl(rawUrl),
      });
      return NextResponse.json({
        mode: "url",
        projectUrl: result.project_url,
        projectId: result.project_id,
        jobId: result.job_id,
      });
    }

    // upload mode
    const fileName = body.fileName?.trim();
    const contentType = body.contentType?.trim();
    const fileSize = Number(body.fileSize);
    if (!fileName || !contentType || !fileSize || fileSize <= 0) {
      return NextResponse.json(
        { error: "fileName, contentType, and fileSize required for upload" },
        { status: 400 }
      );
    }
    const result = await createDescriptProjectForUpload({
      projectName,
      fileName,
      contentType,
      fileSize,
    });
    return NextResponse.json({
      mode: "upload",
      projectUrl: result.projectUrl,
      projectId: result.projectId,
      jobId: result.jobId,
      uploadUrl: result.uploadUrl,
      mediaKey: result.mediaKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
