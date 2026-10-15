import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { MAX_UPLOAD_AUDIO_BYTES, transcribeUploadAudio } from "@/lib/services/clip-editor/transcribe-upload";

/** Transcribe the audio of a clip uploaded into the editor (one Whisper call). */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "No audio" }, { status: 400 });
  }
  if (audio.size > MAX_UPLOAD_AUDIO_BYTES) {
    return NextResponse.json({ error: "That clip is too long to transcribe" }, { status: 413 });
  }
  try {
    return NextResponse.json({ words: await transcribeUploadAudio(audio) });
  } catch (err) {
    console.error("clip-editor transcribe-upload failed", err);
    return NextResponse.json({ error: "Transcription failed" }, { status: 502 });
  }
}
