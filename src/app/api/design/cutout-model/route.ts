import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { getPresignedGetUrl } from "@/lib/s3";

/** The ONNX files the browser cutout runs (src/lib/design-editor/cutout-client.ts),
 *  kept in the app's own bucket so they never depend on a third-party host:
 *  ISNet general-use (DIS, Apache-2.0; the jellybox 1024 export) and MODNet
 *  (Apache-2.0; the Xenova 512 export). Uploaded once by hand, 2026-10-13. */
const MODELS: Record<string, string> = {
  isnet: "hubandspoke/models/isnet-general-use_1024.onnx",
  modnet: "hubandspoke/models/modnet_512.onnx",
};

/** `?name=isnet|modnet` → a short-lived URL for the model file. The browser
 *  caches the bytes (Cache API), so this is hit once per browser per model. */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const key = MODELS[name];
  if (!key) return NextResponse.json({ error: "Unknown model" }, { status: 404 });
  return NextResponse.json({ url: await getPresignedGetUrl(key, 3600) });
}
