export interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

const TIMESTAMP = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function parseVtt(raw: string): VttCue[] {
  const cues: VttCue[] = [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(TIMESTAMP);
    if (!m) {
      i++;
      continue;
    }
    const startSec = toSeconds(m[1], m[2], m[3], m[4]);
    const endSec = toSeconds(m[5], m[6], m[7], m[8]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length === 0) continue;

    let joined = textLines.join(" ").replace(/\s+/g, " ").trim();
    let speaker: string | undefined;
    const speakerMatch = joined.match(/^([A-Za-z0-9_ -]{1,32}):\s+(.*)$/);
    if (speakerMatch) {
      speaker = speakerMatch[1].trim();
      joined = speakerMatch[2];
    }
    cues.push({ startSec, endSec, text: joined, ...(speaker ? { speaker } : {}) });
  }

  return cues;
}

export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
