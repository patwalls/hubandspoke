/**
 * The post title a clip's production item keeps when its hook changes (a
 * clip-editor export, or an edit to the idea's hook). Pure, so the rule is
 * tested.
 *
 * A clip's item starts titled with its hook, and the title follows the hook
 * while nobody has touched it. Once someone types their own title (a
 * shorter post title, a fixed typo), a hook change must keep it: before
 * 2026-10-24 every re-export reset the title to the on-screen hook without
 * an activity event, so editors re-typed the same title after each render
 * and some posts went out under the hook instead.
 */
export function titleAfterHookChange(args: {
  /** The item's title right now. */
  currentTitle: string | null;
  /** Hooks the title could still be "following": the item's stored hook and
   *  the idea's hook (what the item was titled when it was generated). */
  priorHooks: (string | null)[];
  /** The hook it is changing to. */
  newHook: string;
}): string {
  const current = args.currentTitle?.trim() ?? "";
  if (!current) return args.newHook;
  const followsHook = args.priorHooks.some((h) => h != null && h.trim() === current);
  return followsHook ? args.newHook : args.currentTitle!;
}
