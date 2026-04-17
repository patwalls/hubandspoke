import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createDescriptProjectFromUrl,
  createDescriptProjectForUpload,
  toGoogleDriveDirectUrl,
} from "@/lib/descript";

async function persistDescriptProject(
  itemId: string | undefined,
  projectId: string,
  projectUrl: string
) {
  if (!itemId) return;
  try {
    await db
      .update(productionItems)
      .set({
        descriptProjectId: projectId,
        descriptProjectUrl: projectUrl,
        descriptImportedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
  } catch (err) {
    console.error("Failed to persist Descript project to item:", err);
  }
}

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
    itemId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const projectName = body.projectName?.trim() || "Imported video";
  const mode = body.mode || (body.url ? "url" : "upload");
  const itemId = body.itemId?.trim();

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
      await persistDescriptProject(itemId, result.project_id, result.project_url);
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
    await persistDescriptProject(itemId, result.projectId, result.projectUrl);
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
