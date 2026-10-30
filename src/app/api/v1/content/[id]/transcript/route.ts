import { z } from "zod";
import { NextResponse } from "next/server";
import { v1Handler } from "@/lib/api/auth";
import { getTranscript, renderTranscript } from "@/lib/api/content";
import { apiJson, parseQuery, idFromPath, zBool } from "@/lib/api/http";
import { TRANSCRIPT_FORMATS } from "@/lib/api/transcript-format";

export const dynamic = "force-dynamic";

const Query = z.object({
  format: z.enum(TRANSCRIPT_FORMATS).default("json"),
  include_words: zBool.optional(),
});

export const GET = v1Handler("/v1/content/{id}/transcript", async ({ url }) => {
  const id = idFromPath(url, "content");
  const q = parseQuery(url, Query);
  const transcript = await getTranscript(id, { includeWords: q.include_words });
  if (q.format === "json") return apiJson({ data: transcript });
  const { body, contentType } = renderTranscript(transcript, q.format);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="transcript-${id}.${q.format === "text" ? "txt" : q.format}"`,
    },
  });
});
