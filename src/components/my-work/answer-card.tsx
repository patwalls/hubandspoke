"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";
import { firstName, type HandoffPerson } from "@/lib/handoff/pick";
import {
  answerRequest,
  KILL_REASON_MIN,
  type Answer,
  type AnswerKind,
} from "@/lib/my-work/answer";

/**
 * The three answers on /my-work/answer/[id] (rules in
 * src/lib/my-work/answer.ts). Saves through the same routes as My Work's row
 * buttons and the Publish page, so status_change events and notifications
 * are unchanged.
 */
export function AnswerCard({
  id,
  brand,
  me,
  answers,
  picked,
  sentToReviewBy,
  postUrl,
}: {
  id: string;
  brand: string;
  me: string;
  answers: Answer[];
  picked: AnswerKind | null;
  sentToReviewBy: HandoffPerson | null;
  postUrl: string;
}) {
  const [kind, setKind] = useState<AnswerKind | null>(
    picked && answers.some((a) => a.kind === picked) ? picked : null,
  );
  const [link, setLink] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const answer = answers.find((a) => a.kind === kind) ?? null;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const request = answer ? answerRequest(answer.kind, { id, me, sentToReviewBy, link, reason, today }) : null;
  const handBack =
    kind === "approve" && sentToReviewBy && sentToReviewBy.id !== me ? firstName(sentToReviewBy.name) : null;

  async function save() {
    if (!answer || !request) return;
    setBusy(true);
    setError(null);
    trackUsage(`my-work:answer:${answer.kind}`, brand);
    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't save");
      setDone(handBack ? `${answer.to} · back to ${handBack}` : answer.to);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-2" data-answer-done>
        <p className="text-sm text-foreground">
          Done: <strong>{done}</strong>.
        </p>
        <Link href="/my-work" className="text-sm underline">
          See what else is waiting
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Your answer">
        {answers.map((a) => (
          <button
            key={a.kind}
            type="button"
            role="radio"
            aria-checked={kind === a.kind}
            onClick={() => setKind(a.kind)}
            className={cn(
              "rounded-md border px-2 py-2 text-xs font-medium transition-colors",
              kind === a.kind
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {a.label}
          </button>
        ))}
      </div>

      {kind === "posted" && (
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste the live post's link"
          aria-label="Link to the post"
          inputMode="url"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      {kind === "pass" && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why not? Shows in the post's Activity"
          aria-label="Why not"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}

      {kind === "pass" && reason.trim().length > 0 && reason.trim().length < KILL_REASON_MIN && (
        <p className="text-xs text-muted-foreground">A few more words, please (at least {KILL_REASON_MIN} characters).</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Link href={postUrl} className="text-xs text-muted-foreground hover:text-foreground underline">
          Open the post first
        </Link>
        <Button onClick={save} disabled={!request || busy}>
          {!answer
            ? "Pick an answer"
            : answer.kind === "approve"
              ? handBack
                ? `Approve → ${handBack}`
                : "Approve"
              : answer.kind === "posted"
                ? "Mark posted"
                : "Don't post it"}
        </Button>
      </div>
    </div>
  );
}
