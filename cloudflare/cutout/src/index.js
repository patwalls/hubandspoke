// POST {"url": "<https picture URL>"} with `Authorization: Bearer <CUTOUT_SECRET>`
// → a PNG of that picture (longest side ≤ 2048) with the background made
// transparent. Only the app's server calls this; it passes a short-lived
// presigned S3 URL (or a public https URL), never user-typed input.
const worker = {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("POST {url}", { status: 405 });
    const auth = request.headers.get("authorization") ?? "";
    if (!env.CUTOUT_SECRET || auth !== `Bearer ${env.CUTOUT_SECRET}`) return new Response("Unauthorized", { status: 401 });
    let url;
    try {
      ({ url } = await request.json());
      if (new URL(url).protocol !== "https:") throw new Error("https only");
    } catch {
      return new Response("Body must be {url: https://…}", { status: 400 });
    }
    const res = await fetch(url, {
      cf: { image: { segment: "foreground", format: "png", width: 2048, height: 2048, fit: "scale-down" } },
    });
    if (!res.ok) return new Response(`Background removal failed (${res.status}): ${(await res.text()).slice(0, 200)}`, { status: 502 });
    // `cf-resized` says whether the transform actually ran; without it we'd
    // hand back the untouched original, which has no alpha.
    const resized = res.headers.get("cf-resized") ?? "";
    if (!resized.includes("internal=ok")) return new Response(`Background removal didn't run: ${resized || "no cf-resized header"}`, { status: 502 });
    return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "image/png" } });
  },
};

export default worker;
