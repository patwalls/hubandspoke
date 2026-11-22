/**
 * Queue "Age" filter (flag `queueAge`).
 *
 * The triage queue holds every Idea row ever generated — thousands per busy
 * brand, almost all of them from clip-idea batches nobody came back to. In
 * practice people act on ideas from the last few weeks (85% of first actions
 * in a 21-day read were on ideas under 30 days old), so the queue defaults to
 * those and keeps the older ones one click away.
 *
 * Age is measured from the row's `createdAt` (the ProductionItem mapper uses
 * the first edit when there was one, else the insert time).
 */

export const QUEUE_AGE_DAYS = 30;

export type QueueAge = "recent" | "older" | "any";

export const QUEUE_AGE_OPTIONS: { value: QueueAge; label: string }[] = [
  { value: "recent", label: `Last ${QUEUE_AGE_DAYS} days` },
  { value: "older", label: `Older than ${QUEUE_AGE_DAYS} days` },
  { value: "any", label: "Any age" },
];

export function parseQueueAge(raw: string | null | undefined): QueueAge {
  return raw === "older" || raw === "any" ? raw : "recent";
}

/** True when the row was created within the last QUEUE_AGE_DAYS days.
 *  A missing or unparseable date counts as recent, so a row is never hidden
 *  just because we can't tell how old it is. */
export function isRecentIdea(createdAt: string | null | undefined, now: number): boolean {
  if (!createdAt) return true;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return true;
  return now - t < QUEUE_AGE_DAYS * 24 * 60 * 60 * 1000;
}

export function matchesQueueAge(
  createdAt: string | null | undefined,
  age: QueueAge,
  now: number,
): boolean {
  if (age === "any") return true;
  const recent = isRecentIdea(createdAt, now);
  return age === "recent" ? recent : !recent;
}
