/** The stills for `frame` slots: the runner-up shots first (rank 2, 3…),
 *  then the rest of the filmstrip in time order, the cover pick left out so
 *  a story never repeats its cover. Pure, client-safe. */
export function storyFrames<F extends { status: string; origin: string; isPick: boolean; rank: number | null; sec: number; src: unknown }>(frames: F[]): Array<F & { src: NonNullable<F["src"]> }> {
  const done = frames.filter((f): f is F & { src: NonNullable<F["src"]> } => f.status === "done" && f.src != null && !f.isPick && f.origin === "auto");
  const ranked = done.filter((f) => f.rank != null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const rest = done.filter((f) => f.rank == null).sort((a, b) => a.sec - b.sec);
  return [...ranked, ...rest];
}
