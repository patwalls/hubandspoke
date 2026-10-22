/**
 * Previous / Next between clip ideas while the clip editor is open on the
 * queue — so picking one of a dozen ideas isn't close → click → reopen each
 * time. `ids` is the queue's clip rows in the order the table shows them.
 */
export interface IdeaNeighbours {
  /** 1-based place of `current` in `ids`. */
  position: number;
  total: number;
  prev: string | null;
  next: string | null;
}

export function ideaNeighbours(ids: readonly string[], current: string): IdeaNeighbours | null {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length < 2) return null;
  return {
    position: i + 1,
    total: ids.length,
    prev: i > 0 ? ids[i - 1] : null,
    next: i < ids.length - 1 ? ids[i + 1] : null,
  };
}

/** What the clip editor's header needs: where you are, and how to move. */
export interface IdeaNav extends IdeaNeighbours {
  /** Close this idea and open `ideaId` (one of `prev` / `next`). */
  onGo: (ideaId: string) => void;
}
