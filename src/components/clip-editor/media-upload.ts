/**
 * Upload a video file into the edit as its own scene (an intro recorded
 * separately, say). The browser reads the file's size and length, PUTs it
 * straight to S3 through a presigned URL, and hands back the `MediaAsset`
 * the doc stores. Playback uses a local object URL until the next reload, so
 * the new scene plays the moment the upload finishes.
 */
import type { MediaAsset } from "@/lib/clip-editor/doc";

/** An intro or a cutaway, not a second episode. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_UPLOAD_SEC = 10 * 60;

export interface UploadedClip {
  media: MediaAsset;
  /** Plays the file from this browser's memory — no round trip to S3. */
  localUrl: string;
}

/** Duration and display size, from the browser's own decoder. */
function readVideoInfo(url: string): Promise<{ durationSec: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () => {
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      const info = { durationSec: v.duration, width: v.videoWidth, height: v.videoHeight };
      done();
      if (!Number.isFinite(info.durationSec) || info.durationSec <= 0 || !info.width || !info.height) {
        reject(new Error("That file has no playable video"));
      } else resolve(info);
    };
    v.onerror = () => {
      done();
      reject(new Error("This browser can't play that file — try an MP4 or MOV"));
    };
    v.src = url;
  });
}

function put(url: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`))));
    xhr.addEventListener("error", () => reject(new Error("Upload failed — check your connection")));
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(file);
  });
}

export async function uploadClip(args: {
  file: File;
  /** The production item the file is filed under in S3. */
  itemId: string;
  onProgress: (pct: number) => void;
}): Promise<UploadedClip> {
  const { file } = args;
  if (!file.type.startsWith("video/")) throw new Error("Pick a video file");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("That file is over 1 GB");
  const localUrl = URL.createObjectURL(file);
  try {
    const info = await readVideoInfo(localUrl);
    if (info.durationSec > MAX_UPLOAD_SEC) throw new Error("Clips can be up to 10 minutes long");

    const contentType = file.type || "video/mp4";
    const res = await fetch("/api/uploads/s3-presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: args.itemId, fileName: file.name, contentType, fileSize: file.size }),
    });
    const json = (await res.json().catch(() => ({}))) as { uploadUrl?: string; key?: string; error?: string };
    if (!res.ok || !json.uploadUrl || !json.key) throw new Error(json.error ?? "Couldn't start the upload");
    await put(json.uploadUrl, file, contentType, args.onProgress);

    return {
      media: {
        id: `media-${Math.random().toString(36).slice(2, 10)}`,
        key: json.key,
        name: file.name.slice(0, 200),
        durationSec: Math.round(info.durationSec * 1000) / 1000,
        width: info.width,
        height: info.height,
      },
      localUrl,
    };
  } catch (err) {
    URL.revokeObjectURL(localUrl);
    throw err;
  }
}

/** What Whisper wants: one channel at 16 kHz. */
const SPEECH_RATE = 16000;

/**
 * The file's audio as a 16 kHz mono WAV — ~1.9 MB a minute, so even a
 * 10-minute clip fits Whisper's upload cap. Decoded by the browser (an
 * OfflineAudioContext resamples while it decodes). Null when the file has
 * no audio track the browser can read.
 */
async function speechWav(file: File): Promise<Blob | null> {
  let decoded: AudioBuffer;
  try {
    decoded = await new OfflineAudioContext(1, 1, SPEECH_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    return null;
  }
  const n = decoded.length;
  if (n === 0) return null;
  const mono = new Float32Array(n);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, SPEECH_RATE, true);
  out.setUint32(28, SPEECH_RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 0x7fff, true);
  return new Blob([out.buffer], { type: "audio/wav" });
}

/**
 * Transcribe an uploaded clip (one Whisper call, server-side) so its words
 * can be cut and captioned. Resolves to [] for a clip with no audio.
 */
export async function transcribeClip(file: File): Promise<NonNullable<MediaAsset["words"]>> {
  const wav = await speechWav(file);
  if (!wav) return [];
  const body = new FormData();
  body.append("audio", wav, "speech.wav");
  const res = await fetch("/api/clip-editor/transcribe-upload", { method: "POST", body });
  const json = (await res.json().catch(() => ({}))) as { words?: NonNullable<MediaAsset["words"]>; error?: string };
  if (!res.ok || !json.words) throw new Error(json.error ?? "Couldn't transcribe the clip");
  return json.words;
}
