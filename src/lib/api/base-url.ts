/** Public origin for absolute links in API responses — the request's own origin, so dev/preview/prod each link to themselves. */
export function baseUrlFrom(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
