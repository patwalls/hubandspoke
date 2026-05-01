"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CaptionsIcon,
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

interface TranscriptPayload {
  id: string;
  source: string;
  model: string | null;
  language: string | null;
  fullText: string;
  segments: TranscriptSegment[];
  wordCount: number | null;
  durationSec: number | null;
  fetchedAt: string;
}

interface Props {
  itemId: string;
  /** Whether this item has archived media we can transcribe. When false the
   *  dialog only opens if an existing transcript (from the legacy Descript
   *  pipeline or a platform-native source) is already persisted. */
  hasMedia: boolean;
  /** Whether the item has any transcript persisted (e.g. one auto-archived
   *  by the SC enrichment sweep for an IG reel / YouTube video / TikTok).
   *  When true, the dialog opens even without archived media — but the
   *  "Fetch transcript" action stays gated on hasMedia. */
  hasTranscript?: boolean;
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptButton({
  itemId,
  hasMedia,
  hasTranscript = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [fetchState, setFetchState] = useState<
    | { kind: "idle" }
    | { kind: "fetching" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [copyTsState, setCopyTsState] = useState<"idle" | "copied">("idle");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/production-items/${itemId}/transcript`);
      if (res.ok) {
        const json = (await res.json()) as { transcript: TranscriptPayload | null };
        setTranscript(json.transcript);
        setLoaded(true);
      }
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  const handleFetch = useCallback(async () => {
    setFetchState({ kind: "fetching" });
    const priorFetchedAt = transcript?.fetchedAt ?? null;
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/transcript/fetch`,
        { method: "POST" }
      );
      // Tolerate non-JSON bodies — Heroku's 502 error page is HTML, for
      // example, and res.json() would throw "Unexpected token '<'".
      const bodyText = await res.text();
      let json: { error?: string } | null = null;
      try {
        json = bodyText ? (JSON.parse(bodyText) as { error?: string }) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        setFetchState({
          kind: "error",
          message: json?.error || `Fetch failed (${res.status})`,
        });
        return;
      }

      // 202 Accepted: the worker picked up a transcribe-whisper job (ffmpeg
      // extract → Whisper API → persist). Poll GET /transcript until the
      // row appears (detected by a new fetchedAt) or 5 minutes elapse.
      const DEADLINE_MS = 5 * 60 * 1000;
      const POLL_MS = 5000;
      const started = Date.now();
      while (Date.now() - started < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const pollRes = await fetch(
          `/api/production-items/${itemId}/transcript`
        );
        if (!pollRes.ok) continue;
        const pollJson = (await pollRes.json()) as {
          transcript: TranscriptPayload | null;
        };
        const t = pollJson.transcript;
        if (t && t.fetchedAt !== priorFetchedAt) {
          setTranscript(t);
          setLoaded(true);
          setFetchState({ kind: "idle" });
          return;
        }
      }
      setFetchState({
        kind: "error",
        message:
          "Transcript fetch timed out after 5 minutes. The job may still finish — reopen this dialog shortly to check.",
      });
    } catch (err) {
      setFetchState({
        kind: "error",
        message: err instanceof Error ? err.message : "Fetch failed",
      });
    }
  }, [itemId, transcript]);

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript.fullText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("idle");
    }
  }, [transcript]);

  const handleCopyWithTimestamps = useCallback(async () => {
    if (!transcript) return;
    const lines = transcript.segments.map((s) => {
      const speaker = s.speaker ? `${s.speaker}: ` : "";
      return `${fmtTs(s.startSec)}  ${speaker}${s.text}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyTsState("copied");
      setTimeout(() => setCopyTsState("idle"), 1500);
    } catch {
      setCopyTsState("idle");
    }
  }, [transcript]);

  if (!hasMedia && !hasTranscript) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
            title="View the transcript"
          />
        }
      >
        <CaptionsIcon className="size-3.5" /> Transcript
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle>Transcript</DialogTitle>
            {transcript && (
              <span className="text-[11px] text-muted-foreground">
                {transcript.segments.length} segments
                {transcript.wordCount ? ` · ${transcript.wordCount} words` : ""}
                {transcript.durationSec
                  ? ` · ${fmtTs(transcript.durationSec)}`
                  : ""}
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!transcript}
            className="h-7 text-xs gap-1.5"
            title="Copy the full transcript text to the clipboard"
          >
            {copyState === "copied" ? (
              <>
                <CheckIcon className="size-3.5" /> Copied
              </>
            ) : (
              <>
                <CopyIcon className="size-3.5" /> Copy transcript
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyWithTimestamps}
            disabled={!transcript}
            className="h-7 text-xs gap-1.5"
            title="Copy the transcript with per-segment timestamps"
          >
            {copyTsState === "copied" ? (
              <>
                <CheckIcon className="size-3.5" /> Copied
              </>
            ) : (
              <>
                <CopyIcon className="size-3.5" /> Copy transcript with timestamps
              </>
            )}
          </Button>
          {hasMedia && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleFetch}
              disabled={fetchState.kind === "fetching"}
              className="h-7 text-xs gap-1.5"
              title={
                transcript
                  ? "Re-transcribe the archived media with Whisper"
                  : "Transcribe the archived media with Whisper"
              }
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  fetchState.kind === "fetching" && "animate-spin"
                )}
              />
              {fetchState.kind === "fetching"
                ? "Fetching…"
                : transcript
                  ? "Refetch"
                  : "Fetch transcript"}
            </Button>
          )}
        </div>

        {fetchState.kind === "error" && (
          <p className="text-xs text-red-600">{fetchState.message}</p>
        )}

        <div className="flex-1 overflow-y-auto rounded-md border border-border bg-background p-3">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : transcript ? (
            <div className="space-y-1.5">
              {transcript.segments.map((s, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 text-[13px] leading-snug"
                >
                  <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-12">
                    {fmtTs(s.startSec)}
                  </span>
                  <span className="flex-1 text-foreground">
                    {s.speaker && (
                      <span className="font-medium text-muted-foreground">
                        {s.speaker}:{" "}
                      </span>
                    )}
                    {s.text}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {hasMedia
                ? "No transcript yet. Click Fetch transcript to transcribe the archived media."
                : "No transcript yet. The hourly enrichment sweep will fetch one once media is archived."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
