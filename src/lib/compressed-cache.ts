import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { unstable_cache } from "next/cache";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

type CacheOptions = Parameters<typeof unstable_cache>[2];

/**
 * `unstable_cache` for payloads that can outgrow Next's 2 MB per-entry limit.
 *
 * Over the limit Next logs a warning, stores nothing and returns the fresh
 * value, so the page keeps working while every request silently recomputes.
 * That took the Starter Story queue from <300ms to 25–83s on 2026-11-08 and
 * cut RSC streams at Heroku's 55s idle limit (React #412, GlitchTip issue 48).
 *
 * The entry is gzipped JSON in base64, which is ~10× smaller on these reports
 * (repeated keys and account objects). Callers see what `unstable_cache`
 * gives them: a JSON round-trip of the value, so dates are ISO strings at
 * runtime.
 */
export function compressedCache<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  keyParts: string[],
  options: CacheOptions,
): (...args: Args) => Promise<Result> {
  const cached = unstable_cache(
    async (...args: Args) => {
      const json = JSON.stringify(await fn(...args));
      return (await gzipAsync(json)).toString("base64");
    },
    // "gzip" keeps these apart from any entry written in the old raw shape.
    [...keyParts, "gzip"],
    options,
  );
  return async (...args: Args) => {
    const json = await gunzipAsync(Buffer.from(await cached(...args), "base64"));
    return JSON.parse(json.toString("utf8")) as Result;
  };
}
