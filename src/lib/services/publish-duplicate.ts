import type { DuplicateMatch } from "./production-items-dedup";

/**
 * What publishing a link should do about a row that already owns its
 * platform-native id. The usual case is the account sync having pulled the
 * live post in before anyone pasted its link: same account, so the synced
 * row folds into the planned item (which keeps its editor, comments and
 * history; same rule as schedule-reconcile). A row on another account means
 * the link or the account is wrong: refuse, as the generic PUT does.
 * An item with no account can't be merged (merge requires one account) and
 * publishes without the key, as it always has.
 */
export type PublishDuplicateAction =
  | { kind: "none" }
  | { kind: "merge"; duplicateId: string }
  | { kind: "conflict"; duplicate: DuplicateMatch }
  | { kind: "skip-key" };

export function publishDuplicateAction(
  itemAccountId: string | null,
  duplicate: DuplicateMatch | null,
): PublishDuplicateAction {
  if (!duplicate) return { kind: "none" };
  if (!itemAccountId) return { kind: "skip-key" };
  if (duplicate.accountId === itemAccountId) {
    return { kind: "merge", duplicateId: duplicate.id };
  }
  return { kind: "conflict", duplicate };
}
