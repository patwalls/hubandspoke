"use client";

import { useEffect } from "react";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/notifications/unread";

/**
 * Opening a post means you've seen what the notifications about it were
 * pointing at: mark them read and tell the bell to refetch. Runs once per
 * post id, so stepping to the next post (production run, open-next) clears
 * that one too. Fire-and-forget — a failure just leaves the bell as it was.
 */
export function useMarkPostNotificationsRead(contentItemId: string | null | undefined) {
  useEffect(() => {
    if (!contentItemId) return;
    fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentItemId }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as { updated?: number } | null;
        if ((json?.updated ?? 0) > 0) {
          window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
        }
      })
      .catch(() => {});
  }, [contentItemId]);
}
