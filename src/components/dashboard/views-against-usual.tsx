"use client";

import { useEffect } from "react";
import { formatLift, type AgainstUsual } from "@/lib/winners/pick";
import { trackUsage } from "@/lib/usage/track";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * The post page's Views card footer: how this post did against its own
 * account's usual (same rules as the dashboard's "Beat their usual" strip,
 * `src/lib/winners/pick.ts`). A post that beat it says "N× its usual" in
 * green; any other post just names the usual — never a below-usual ratio,
 * since a post a few hours old is under it by definition. Renders nothing
 * when the account has no usual yet.
 */
export function ViewsAgainstUsual({ brand, value }: { brand: string; value: AgainstUsual | null }) {
  const beat = value?.lift != null;
  useEffect(() => {
    if (beat) trackUsage("content:beat-usual", brand);
  }, [beat, brand]);

  if (!value) return null;
  const unit = value.metric === "likes" ? " likes" : "";
  const title = `Median ${value.metric} of this account's posts of the same type in the 90 days before this one (${value.basedOn} posts)`;
  return (
    <span title={title} data-testid="views-against-usual">
      {" · "}
      {value.lift != null && (
        <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatLift(value.lift)} its usual · </span>
      )}
      usual {compact.format(value.usual)}
      {unit}
    </span>
  );
}

/**
 * Under the Views card's footer on a post that beat its usual: the
 * `winner-notes` cron's one-line "why it won" (Haiku, written once per
 * winner). Renders nothing until the note exists, or when the post isn't a
 * win right now (`withWhy` in pick.ts). Clamped to two lines; the full note is
 * the tooltip.
 */
export function WhyItWon({ brand, value }: { brand: string; value: AgainstUsual | null }) {
  const why = value?.lift != null ? value.why : null;
  useEffect(() => {
    if (why) trackUsage("content:why-it-won", brand);
  }, [why, brand]);

  if (!why) return null;
  return (
    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground" title={why} data-testid="why-it-won">
      <span className="font-medium text-foreground/80">Why it won:</span> {why}
    </p>
  );
}
