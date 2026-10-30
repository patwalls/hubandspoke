/**
 * Render a transcript's segments as plain text, WebVTT or SRT. Pure — unit
 * tested in transcript-format.test.ts. Speaker labels, when present, lead the
 * cue text (`Pat: …`) in every format, which is how captions tools expect them.
 */
export interface TranscriptSegmentLike {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

export type TranscriptFormat = "json" | "text" | "vtt" | "srt";
export const TRANSCRIPT_FORMATS: TranscriptFormat[] = ["json", "text", "vtt", "srt"];

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** `HH:MM:SS.mmm` (VTT) or `HH:MM:SS,mmm` (SRT). */
export function formatTimestamp(sec: number, separator: "." | "," = "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`;
}

function cueText(seg: TranscriptSegmentLike): string {
  const text = seg.text.trim();
  return seg.speaker ? `${seg.speaker}: ${text}` : text;
}

export function toPlainText(segments: TranscriptSegmentLike[]): string {
  const lines: string[] = [];
  let lastSpeaker: string | undefined;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (seg.speaker && seg.speaker !== lastSpeaker) {
      lines.push(`${seg.speaker}: ${text}`);
    } else {
      lines.push(text);
    }
    lastSpeaker = seg.speaker;
  }
  return lines.join("\n");
}

export function toVtt(segments: TranscriptSegmentLike[]): string {
  const out = ["WEBVTT", ""];
  segments.forEach((seg) => {
    out.push(`${formatTimestamp(seg.startSec)} --> ${formatTimestamp(seg.endSec)}`);
    out.push(cueText(seg));
    out.push("");
  });
  return out.join("\n");
}

export function toSrt(segments: TranscriptSegmentLike[]): string {
  const out: string[] = [];
  segments.forEach((seg, i) => {
    out.push(String(i + 1));
    out.push(`${formatTimestamp(seg.startSec, ",")} --> ${formatTimestamp(seg.endSec, ",")}`);
    out.push(cueText(seg));
    out.push("");
  });
  return out.join("\n");
}

export function contentTypeFor(format: TranscriptFormat): string {
  switch (format) {
    case "vtt":
      return "text/vtt; charset=utf-8";
    case "srt":
    case "text":
      return "text/plain; charset=utf-8";
    default:
      return "application/json";
  }
}
