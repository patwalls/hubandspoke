/** The next row after `fromId` (in `order`) that isn't in `done`, or null when
 *  every row after it is done. Used by the link boxes on the Publish screen and
 *  the content page's Cross-post tab: paste, Enter, and the cursor moves on. */
export function nextOpenId(
  order: string[],
  fromId: string,
  done: Record<string, unknown>,
): string | null {
  const start = order.indexOf(fromId);
  if (start === -1) return null;
  for (let j = start + 1; j < order.length; j++) {
    if (!done[order[j]]) return order[j];
  }
  // Wrap: a row above that was skipped is still waiting.
  for (let j = 0; j < start; j++) {
    if (!done[order[j]]) return order[j];
  }
  return null;
}
