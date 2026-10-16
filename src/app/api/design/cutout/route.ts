import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { imageSourceSchema } from "@/lib/editor/image-source";
import { getPresignedGetUrl } from "@/lib/s3";

/** `POST { src: ImageSource }` → a transparent PNG of the picture (longest
 *  side ≤ 2048) from the `hs-cutout` Cloudflare Worker (cloudflare/cutout/),
 *  which runs BiRefNet through Cloudflare Images. We hand the Worker a
 *  short-lived URL it fetches itself, so the browser uploads nothing and the
 *  secret stays on the server. 503 when not configured (local dev) → the
 *  browser falls back to its own ISNet (src/lib/design-editor/cutout-client.ts). */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const worker = process.env.CUTOUT_WORKER_URL;
  const secret = process.env.CUTOUT_WORKER_SECRET;
  if (!worker || !secret) return NextResponse.json({ error: "Cloud cutouts aren't configured" }, { status: 503 });

  const parsed = imageSourceSchema.safeParse(((await request.json().catch(() => null)) as { src?: unknown } | null)?.src);
  if (!parsed.success) return NextResponse.json({ error: "Bad picture" }, { status: 400 });
  const src = parsed.data;
  let url: string;
  if (src.kind === "s3") url = await getPresignedGetUrl(src.key, 600, src.bucket ? { bucket: src.bucket } : undefined);
  else if (src.kind === "url" && src.url.startsWith("https://")) url = src.url;
  else return NextResponse.json({ error: "Only stored or https pictures can be cut out in the cloud" }, { status: 422 });

  const res = await fetch(worker, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(25_000),
  }).catch((err: unknown) => err);
  if (!(res instanceof Response)) return NextResponse.json({ error: `Cutout service unreachable: ${res instanceof Error ? res.message : String(res)}` }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: `Cutout service failed (${res.status}): ${(await res.text()).slice(0, 200)}` }, { status: 502 });
  return new NextResponse(res.body, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
}
