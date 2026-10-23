/**
 * Bulk changes on My Work: select rows, then move them all to one status,
 * kill them, or delete them. Pure, so the rules are tested.
 *
 * Statuses are per brand, so "Move to" only offers a status every selected
 * row's brand has, in the first brand's order. Published and Scheduled only
 * go through the publish route (the PUT rejects them), and Killed needs a
 * reason, so it gets its own button.
 */

const NOT_A_MOVE = new Set(["Published", "Scheduled", "Killed"]);

export function bulkMoveTargets(
  brands: readonly string[],
  statusesByBrand: Readonly<Record<string, readonly string[]>>,
): string[] {
  const unique = [...new Set(brands)];
  if (unique.length === 0) return [];
  const [first, ...rest] = unique.map((b) => statusesByBrand[b] ?? []);
  const others = rest.map((s) => new Set(s));
  return first.filter((s) => !NOT_A_MOVE.has(s) && others.every((o) => o.has(s)));
}

/** Runs `fn` over `items`, `size` at a time, and counts what failed. */
export async function inBatches<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<unknown>,
): Promise<{ ok: number; failed: number; firstError: string | null }> {
  let ok = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else {
        failed++;
        firstError ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    }
  }
  return { ok, failed, firstError };
}
