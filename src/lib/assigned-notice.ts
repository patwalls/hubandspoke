// What the post page says after you assign someone: the PUT reports how the
// new editor was told (enqueueNotification's NotificationDelivery). The
// curator used to follow almost every assignment with a bare "@name" comment
// (75 in 30 days, ~6 s later, 68 of them after the assignment email had
// already gone) — this line is there so the ping isn't needed.

export interface AssignedNotice {
  name: string | null;
  delivery: "none" | "bell" | "email";
}

/** The toast after an assignment, or null when nobody was told (you assigned
 *  yourself, unassigned, or the person is deactivated). First name only. */
export function assignedNoticeText(notice: AssignedNotice | null | undefined): string | null {
  if (!notice || notice.delivery === "none") return null;
  const first = notice.name?.trim().split(/\s+/)[0] || "The editor";
  return notice.delivery === "email"
    ? `${first} was notified by email and in their bell`
    : `${first} has no login yet, so they weren't emailed — let them know another way`;
}
