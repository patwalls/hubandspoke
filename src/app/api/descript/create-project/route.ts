import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createDescriptProjectFromUrl,
  toGoogleDriveDirectUrl,
} from "@/lib/descript";
import { getPresignedGetUrl } from "@/lib/s3";

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
    mode?: "url" | "s3";
    url?: string;
    s3Key?: string;
    projectName?: string;
    itemId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const projectName = body.projectName?.trim() || "Imported video";
  const itemId = body.itemId?.trim();
  const mode = body.mode || (body.url ? "url" : body.s3Key ? "s3" : null);

  if (!mode) {
    return NextResponse.json(
      { error: "mode required (url or s3)" },
      { status: 400 }
    );
  }

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

    // s3 mode — fetch presigned GET URL for the saved object, hand to Descript.
    const s3Key = body.s3Key?.trim();
    if (!s3Key) {
      return NextResponse.json({ error: "s3Key required" }, { status: 400 });
    }
    // Descript fetches the file shortly after; 2 hours covers slow imports.
    const mediaUrl = await getPresignedGetUrl(s3Key, 60 * 60 * 2);
    const result = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl,
    });
    await persistDescriptProject(itemId, result.project_id, result.project_url);
    return NextResponse.json({
      mode: "s3",
      projectUrl: result.project_url,
      projectId: result.project_id,
      jobId: result.job_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
