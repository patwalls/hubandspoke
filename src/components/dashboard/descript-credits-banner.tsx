"use client";

import { useEffect, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";

interface DescriptCreditsState {
  exhausted: boolean;
  failedCount: number;
  sinceIso: string | null;
  sampleError: string | null;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

/**
 * Red banner that shows up when Descript is rejecting our agent jobs
 * with "Insufficient AI credits". Polls `/api/descript-credits-status`
 * every 60s so the banner clears itself once Pat tops up — no refresh
 * needed.
 *
 * Mounted in the dashboard layout next to the SC banner. Stays hidden
 * in the common case where credits are fine, so it has zero visual
 * cost when nothing is wrong.
 */
export function DescriptCreditsBanner() {
  const [state, setState] = useState<DescriptCreditsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/descript-credits-status");
        if (!res.ok) return;
        const json = (await res.json()) as DescriptCreditsState;
        if (!cancelled) setState(json);
      } catch {
        // Silent — don't crash the dashboard on a flaky status fetch.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!state || !state.exhausted) return null;

  return (
    <div className="mb-3 sm:mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-red-600" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            Descript is out of AI credits.
          </div>
          <div className="mt-0.5 text-xs text-red-800">
            {state.failedCount} Descript job attempt{state.failedCount === 1 ? "" : "s"}{" "}
            stuck{" "}
            {state.sinceIso ? `since ${formatRelative(state.sinceIso)}` : "in the last hour"}
            . Cross-posts, reposts, and clip-promotions that need a new
            Descript composition will queue up until you top up.
          </div>
          <a
            href="https://web.descript.com/settings/billing"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs font-medium text-red-700 hover:text-red-900 underline underline-offset-2"
          >
            Top up Descript →
          </a>
        </div>
      </div>
    </div>
  );
}
