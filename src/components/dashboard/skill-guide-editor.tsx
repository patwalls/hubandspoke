"use client";

// The format Skill as one plain-text box (normal font, no markdown, a
// worked example as the placeholder) plus "Build with AI": a short panel of
// plain questions — how the caption is formatted, what to look for in the
// video, the hook, other rules — and optional screenshots. The AI
// (POST /api/formats/build-skill) writes the whole Skill into the box,
// keeping anything already there; Undo puts the old text back. Same
// component on the Add format dialog and the format detail page.

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, Undo2, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { FormatFamily } from "@/lib/format-kinds";
import { SET_ELSEWHERE, SKILL_EXAMPLE, SKILL_QUESTIONS } from "@/lib/format-skill-guide";
import { describeLookSuggestion, type LookSuggestion } from "@/lib/clip-editor/look-from-example";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface StagedImage {
  id: string;
  mediaType: string;
  dataB64: string;
  previewUrl: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result ?? "");
      const i = r.indexOf(",");
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
    reader.readAsDataURL(file);
  });
}

export function SkillGuideEditor({
  value,
  onChange,
  onCommit,
  family,
  brand,
  kindLabel,
  formatName,
  onSuggestName,
  onLook,
  lookMode = "auto",
  readOnly,
  rows = 10,
  textareaClassName,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Called on blur and after an AI write — the detail page persists here. */
  onCommit?: (next: string) => void;
  family: FormatFamily;
  brand: string;
  /** "Instagram Reel" — tells the AI what it's writing for. */
  kindLabel: string;
  formatName?: string | null;
  /** The AI's name suggestion, for a dialog whose Name is still empty. */
  onSuggestName?: (name: string) => void;
  /** Clip formats, "Upload examples": the look the AI read off the examples.
   *  "auto" hands it over straight away (a new format has no look yet);
   *  "offer" shows a button, so an existing look is never replaced silently. */
  onLook?: (look: LookSuggestion) => void | Promise<void>;
  lookMode?: "auto" | "offer";
  readOnly?: boolean;
  rows?: number;
  textareaClassName?: string;
  testId?: string;
}) {
  const questions = SKILL_QUESTIONS[family];
  const [builderOpen, setBuilderOpen] = useState(false);
  // Two ways in: answer the questions, or show examples and let the AI work
  // the whole Skill out from them.
  const [mode, setMode] = useState<"questions" | "examples">("questions");
  const [note, setNote] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [images, setImages] = useState<StagedImage[]>([]);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [lookFound, setLookFound] = useState<{ look: LookSuggestion; applied: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.previewUrl)), []);

  const hasInput =
    mode === "examples" ? images.length > 0 : questions.some((q) => answers[q.id]?.trim());

  async function addImages(files: FileList | File[]) {
    const next: StagedImage[] = [];
    for (const f of Array.from(files).slice(0, MAX_IMAGES - images.length)) {
      if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) continue;
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mediaType: f.type,
        dataB64: await fileToBase64(f),
        previewUrl: URL.createObjectURL(f),
      });
    }
    setImages((prev) => [...prev, ...next]);
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  }

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/formats/build-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          family,
          kindLabel,
          formatName: formatName ?? null,
          existing: value || null,
          answers:
            mode === "examples"
              ? [{ question: "Anything to add about these examples?", answer: note }]
              : questions.map((q) => ({ question: q.question, answer: answers[q.id] ?? "" })),
          images: mode === "examples" ? images.map((i) => ({ mediaType: i.mediaType, dataB64: i.dataB64 })) : [],
          fromExamples: mode === "examples",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.skill) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setPrevious(value);
      onChange(json.skill);
      onCommit?.(json.skill);
      if (json.suggestedName && !formatName?.trim()) onSuggestName?.(json.suggestedName);
      if (json.look && onLook) {
        if (lookMode === "auto") await onLook(json.look);
        setLookFound({ look: json.look, applied: lookMode === "auto" });
      }
      setBuilderOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="space-y-2">
      {!readOnly && !builderOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBuilderOpen(true)}
            data-testid={testId ? `${testId}-build` : undefined}
          >
            <Sparkles /> Build with AI
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Answer a few questions and the AI writes it for you{value.trim() ? ", keeping what's already here" : ""}.
          </span>
          {previous !== null && (
            <button
              type="button"
              onClick={() => {
                onChange(previous);
                onCommit?.(previous);
                setPrevious(null);
              }}
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Undo2 className="size-3" /> Undo AI rewrite
            </button>
          )}
        </div>
      )}

      {builderOpen && (
        <div
          className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
          onPaste={onPaste}
          data-testid={testId ? `${testId}-builder` : undefined}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Build the Skill with AI</p>
              <p className="text-[11px] text-muted-foreground">
                {mode === "questions"
                  ? "Answer whatever you know, in your own words. Skip the rest."
                  : "Show the AI a few example posts and it works out the whole Skill from them."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setBuilderOpen(false)}
              className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
              data-testid={testId ? `${testId}-write-myself` : undefined}
            >
              Write it myself instead
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-background/80 p-1" role="group" aria-label="How to build it">
            {([
              ["questions", "Answer questions"],
              ["examples", "Upload examples"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={mode === k}
                onClick={() => {
                  setMode(k);
                  setError(null);
                }}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs transition-colors",
                  mode === k ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={testId ? `${testId}-mode-${k}` : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "questions" && (
            <>
            {questions.map((q) => (
              <label key={q.id} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">{q.question}</span>
                {/* The example stays visible while typing (a placeholder would vanish). */}
                <span className="text-[11px] leading-snug text-muted-foreground">{q.placeholder}</span>
                <Textarea
                  rows={2}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Your answer…"
                  className="min-h-0 bg-background text-sm"
                  data-testid={testId ? `${testId}-q-${q.id}` : undefined}
                />
              </label>
            ))}
            </>
          )}
          {mode === "examples" && (
            <div className="flex flex-col gap-2">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer?.files?.length) void addImages(e.dataTransfer.files);
                }}
                onClick={() => images.length < MAX_IMAGES && fileRef.current?.click()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-background px-4 py-6 text-center transition-colors",
                  dragOver ? "border-primary bg-primary/5" : "hover:bg-accent/40",
                )}
                data-testid={testId ? `${testId}-dropzone` : undefined}
              >
                <ImagePlus className="size-5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Drop, paste or click to add screenshots</span>
                <span className="text-[11px] text-muted-foreground">
                  2–6 example posts work best: the captions, the on-screen text, the slides. Up to {MAX_IMAGES}.
                </span>
              </div>
              {images.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {images.map((img) => (
                    <div key={img.id} className="relative size-16 overflow-hidden rounded-md border bg-background">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.previewUrl} alt="" className="size-full object-cover" />
                      <button
                        type="button"
                        aria-label="Remove screenshot"
                        onClick={() => {
                          URL.revokeObjectURL(img.previewUrl);
                          setImages((prev) => prev.filter((p) => p.id !== img.id));
                        }}
                        className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  Anything to add? <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Same style, but never use emoji."
                  className="min-h-0 bg-background text-sm"
                />
              </label>
            </div>
          )}
          {SET_ELSEWHERE[family] && (
            <p className="rounded-md bg-background/70 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
              {SET_ELSEWHERE[family]}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setBuilderOpen(false)} disabled={building}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void build()}
              disabled={building || !hasInput}
              data-testid={testId ? `${testId}-write` : undefined}
            >
              {building ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {building
                ? mode === "examples" ? "Reading your examples…" : "Writing…"
                : mode === "examples"
                  ? "Write my Skill from these"
                  : value.trim() ? "Rewrite my Skill" : "Write my Skill"}
            </Button>
          </div>
        </div>
      )}

      {/* While the builder is open only the questions show — the box comes
          back with the AI's write-up (or as it was, on Cancel). */}
      {!builderOpen && (
        <>
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit?.(value)}
            rows={rows}
            readOnly={readOnly || building}
            placeholder={SKILL_EXAMPLE[family]}
            className={cn("text-sm leading-relaxed", textareaClassName)}
            data-testid={testId}
          />
          <p className="text-[11px] text-muted-foreground">
            Write it like you&apos;re explaining the format to a new editor. Plain sentences are perfect.
          </p>
          {lookFound && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" data-testid={testId ? `${testId}-look-found` : undefined}>
              <span className="flex-1">
                {lookFound.applied ? "The clip look will start from your examples: " : "Your examples' clip look: "}
                {describeLookSuggestion(lookFound.look)}.
              </span>
              {!lookFound.applied && onLook && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 bg-background text-xs"
                  onClick={async () => {
                    await onLook(lookFound.look);
                    setLookFound({ ...lookFound, applied: true });
                  }}
                >
                  Use it for the clip look
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
