"use client";

/**
 * Speaker bar for the transcript dialog: who is in this recording, how much
 * each talks, click-to-rename, and the detect / re-detect control with live
 * job progress. Names shown here are the ones written into
 * `segments[].speaker`, i.e. what LLM prompts and "copy with timestamps" use —
 * so fixing a name here fixes it everywhere.
 */
import { useState } from "react";
import { Loader2Icon, PencilIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptSpeaker } from "@/lib/diarization/types";

export interface SpeakerDetectionStatus {
  available: boolean;
  status: "running" | "done" | "failed" | null;
  chunksDone: number;
  chunksTotal: number;
  error: string | null;
}

/** Stable colour per speaker position. Tailwind needs literal class names. */
const SPEAKER_COLORS = [
  { dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" },
  { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  { dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-400" },
  { dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-400" },
  { dot: "bg-teal-500", text: "text-teal-700 dark:text-teal-400" },
];

export function speakerColor(index: number) {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

export function speakerLabel(speaker: TranscriptSpeaker, index: number): string {
  return speaker.name?.trim() || `Speaker ${index + 1}`;
}

export function TranscriptSpeakers({
  speakers,
  detection,
  starting,
  onDetect,
  onRename,
}: {
  speakers: TranscriptSpeaker[] | null;
  detection: SpeakerDetectionStatus;
  starting: boolean;
  onDetect: () => void;
  onRename: (speakerId: string, name: string) => Promise<void>;
}) {
  const running = detection.status === "running" || starting;
  const total = (speakers ?? []).reduce((n, s) => n + s.talkTimeSec, 0) || 1;

  if (!detection.available && !speakers) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <UsersIcon className="size-3.5" /> Speakers
      </span>

      {running ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Detecting speakers…
          {detection.chunksTotal > 0 &&
            ` part ${Math.min(detection.chunksDone + 1, detection.chunksTotal)} of ${detection.chunksTotal}`}
          <span className="opacity-70">(a few minutes per 10 min of audio — you can close this)</span>
        </span>
      ) : speakers && speakers.length >= 2 ? (
        speakers.map((s, i) => (
          <SpeakerChip
            key={s.id}
            speaker={s}
            index={i}
            sharePct={Math.round((s.talkTimeSec / total) * 100)}
            onRename={onRename}
          />
        ))
      ) : speakers && speakers.length === 1 ? (
        <span className="text-muted-foreground">One speaker detected — no labels needed.</span>
      ) : detection.status === "failed" ? (
        <span className="text-red-600" title={detection.error ?? undefined}>
          Speaker detection failed.
        </span>
      ) : (
        <span className="text-muted-foreground">Not detected yet.</span>
      )}

      {detection.available && !running && (
        <button
          type="button"
          onClick={onDetect}
          className="ml-auto rounded border border-border bg-background px-2 py-0.5 font-medium hover:bg-muted"
        >
          {speakers ? "Re-detect" : "Detect speakers"}
        </button>
      )}
    </div>
  );
}

function SpeakerChip({
  speaker,
  index,
  sharePct,
  onRename,
}: {
  speaker: TranscriptSpeaker;
  index: number;
  sharePct: number;
  onRename: (speakerId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(speaker.name ?? "");
  const color = speakerColor(index);

  const commit = async () => {
    setEditing(false);
    if (value.trim() !== (speaker.name ?? "")) await onRename(speaker.id, value);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", color.dot)} aria-hidden />
      {editing ? (
        <input
          autoFocus
          value={value}
          placeholder={`Speaker ${index + 1}`}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setValue(speaker.name ?? "");
              setEditing(false);
            }
          }}
          className="w-32 rounded border border-sky-400 bg-background px-1 py-0.5 text-xs outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={
            speaker.nameSource === "llm"
              ? "Name guessed from the recording — click to correct"
              : "Click to name this speaker"
          }
          className={cn("group inline-flex items-center gap-1 font-semibold hover:underline", color.text)}
        >
          {speakerLabel(speaker, index)}
          <PencilIcon className="size-2.5 opacity-0 transition-opacity group-hover:opacity-60" />
        </button>
      )}
      <span className="text-muted-foreground">
        {speaker.role !== "unknown" && `${speaker.role} · `}
        {sharePct}%
      </span>
    </span>
  );
}
