"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trackUsage } from "@/lib/usage/track";

export interface WhatsNewCard {
  id: string;
  shippedAt: string;
  kind: "feature" | "fix";
  title: string;
  body: string;
  href?: string;
}

/** Fired by the nav's "What's new" menu item to reopen the full list. */
export const OPEN_WHATS_NEW_EVENT = "whats-new:open";

/**
 * The What's new pop-up. Opens by itself on page load when `unseen` has
 * cards; dismissing (or following a card's link) stamps
 * `users.whats_new_seen_at` so those cards don't come back. The nav menu
 * reopens it with every card this user can see.
 */
export function WhatsNewDialog({
  unseen,
  all,
}: {
  unseen: WhatsNewCard[];
  all: WhatsNewCard[];
}) {
  const [mode, setMode] = useState<"unseen" | "all" | null>(unseen.length > 0 ? "unseen" : null);
  const [stamped, setStamped] = useState(false);

  useEffect(() => {
    const open = () => {
      trackUsage("whats-new:open-list");
      setMode("all");
    };
    window.addEventListener(OPEN_WHATS_NEW_EVENT, open);
    return () => window.removeEventListener(OPEN_WHATS_NEW_EVENT, open);
  }, []);

  useEffect(() => {
    if (mode === "unseen") trackUsage("whats-new:popup");
  }, [mode]);

  const markSeen = () => {
    if (stamped || unseen.length === 0) return;
    setStamped(true);
    void fetch("/api/whats-new/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upTo: unseen[0].shippedAt }),
      keepalive: true,
    }).catch(() => {});
  };

  const close = () => {
    if (mode === "unseen") markSeen();
    setMode(null);
  };

  const cards = mode === "all" ? all : unseen;

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription>
            {mode === "all"
              ? "Everything that's shipped lately, newest first."
              : "A few things got better since you were last here."}
          </DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 max-h-[60vh] space-y-3 overflow-y-auto px-1">
          {cards.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-foreground">{c.title}</div>
                <div className="shrink-0 text-xs text-muted-foreground">
                  {c.kind === "fix" ? "Fix · " : ""}
                  {new Date(c.shippedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </div>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{c.body}</p>
              {c.href ? (
                <Link
                  href={c.href}
                  className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                  onClick={() => {
                    trackUsage(`whats-new:click:${c.id}`);
                    close();
                  }}
                >
                  Try it →
                </Link>
              ) : null}
            </li>
          ))}
          {cards.length === 0 ? (
            <li className="text-sm text-muted-foreground">Nothing new yet.</li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button onClick={close}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
