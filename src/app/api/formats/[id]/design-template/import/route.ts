import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { designTemplateImports, formats } from "@/lib/db/schema";
import { bucketName, buildKey, putObject } from "@/lib/s3";
import { enqueue } from "@/jobs/enqueue";
import { MAX_PDF_BYTES } from "@/lib/services/design-editor/pdf-import";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Start importing a template from a PDF (multipart `file`). Stores the PDF,
 *  queues `design-template-import` and returns the import id to poll. The
 *  format's template is untouched. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [format] = await db.select({ id: formats.id }).from(formats).where(eq(formats.id, id)).limit(1);
  if (!format) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return NextResponse.json({ error: "Upload a PDF" }, { status: 415 });
  if (file.size > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF is over 20 MB" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return NextResponse.json({ error: "That file isn't a readable PDF" }, { status: 415 });

  const key = buildKey(id, `design-template-import-${Date.now()}.pdf`);
  await putObject(key, buf, "application/pdf");
  const [row] = await db
    .insert(designTemplateImports)
    .values({ formatId: id, fileName: file.name || null, s3Bucket: bucketName(), s3Key: key, createdBy: guard.session.user?.id ?? null })
    .returning({ id: designTemplateImports.id });
  await enqueue("design-template-import", { importId: row.id }, { maxAttempts: 2 });
  return NextResponse.json({ importId: row.id });
}
