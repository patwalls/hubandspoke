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
  ExternalLinkIcon,
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
  language: string | null;
  fullText: string;
  segments: TranscriptSegment[];
  wordCount: number | null;
  durationSec: number | null;
  descriptShareUrl: string | null;
  descriptPublishedAt: string | null;
  fetchedAt: string;
}

interface Props {
  itemId: string;
  hasDescriptProject: boolean;
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptButton({ itemId, hasDescriptProject }: Props) {
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
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/transcript/fetch`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) {
        setFetchState({
          kind: "error",
          message: json?.error || `Fetch failed (${res.status})`,
        });
        return;
      }
      setFetchState({ kind: "idle" });
      await load();
    } catch (err) {
      setFetchState({
        kind: "error",
        message: err instanceof Error ? err.message : "Fetch failed",
      });
    }
  }, [itemId, load]);

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

  if (!hasDescriptProject) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
            title="View the transcript pulled from the Descript composition"
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
            onClick={handleFetch}
            disabled={fetchState.kind === "fetching"}
            className="h-7 text-xs gap-1.5"
            title={
              transcript
                ? "Re-publish the composition and re-fetch the transcript"
                : "Publish the Descript composition and fetch its transcript"
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
          {transcript?.descriptShareUrl && (
            <a
              href={transcript.descriptShareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-7 text-xs gap-1.5"
              )}
              title="Open the Descript share page"
            >
              <ExternalLinkIcon className="size-3.5" /> Descript share
            </a>
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
              No transcript yet. Click Fetch transcript to publish the Descript
              composition and pull its WEBVTT subtitles.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
