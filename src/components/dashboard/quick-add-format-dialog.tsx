"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlusIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const ACCEPTED_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

interface StagedImage {
  id: string;
  mediaType: string;
  /** base64-encoded (NO `data:...;base64,` prefix). */
  dataB64: string;
  /** Object URL for the <img> preview. */
  previewUrl: string;
  /** Original filename for display. */
  name: string;
  /** Size in bytes for display. */
  size: number;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      // `data:image/png;base64,<...>` → strip the data-URL prefix.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

interface DraftedFormat {
  name: string;
  instructions: string;
  suggestedPostType: string;
  suggestedPlatform: string[];
  suggestedAspectRatio: "9:16" | "16:9";
  suggestedParentFormatId: string | null;
}

interface Props {
  brand: string;
  /** Pre-fill parent format (optional). Used when the dialog is opened
   *  from a per-pillar context where the pillar's format is the obvious
   *  parent. */
  parentFormatId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a format is successfully created — gives the parent a
   *  chance to refetch the formats list. */
  onCreated?: (formatId: string) => void;
}

/**
 * Quick-add a new clippable format from a 1-2 sentence description.
 * Calls the Haiku-backed draft-skill endpoint, lets the operator
 * review/tweak the result, then POSTs to /api/formats with the
 * `isClippableFormat: true` flag pre-set.
 *
 * Intended to replace the multi-step "Add Format" flow for the common
 * case of "I had an idea for a new clip format and want to wire it up in
 * 10 seconds."
 */
export function QuickAddFormatDialog({
  brand,
  parentFormatId,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const [stage, setStage] = useState<"input" | "review">("input");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<StagedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftedFormat | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    // Revoke any object URLs we created so they don't leak. The browser
    // already cleans up when the page unloads, but the dialog can open +
    // close many times in one session.
    for (const img of images) {
      URL.revokeObjectURL(img.previewUrl);
    }
    setStage("input");
    setDescription("");
    setImages([]);
    setImageError(null);
    setDraft(null);
    setError(null);
    setDrafting(false);
    setSaving(false);
  }

  // Revoke object URLs when the component unmounts, in addition to reset().
  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setImageError(null);
      const incoming = Array.from(files);
      if (incoming.length === 0) return;
      const remainingSlots = MAX_IMAGES - images.length;
      if (remainingSlots <= 0) {
        setImageError(`Already at the ${MAX_IMAGES}-image limit.`);
        return;
      }
      const accept = incoming.slice(0, remainingSlots);
      const dropped = incoming.length - accept.length;
      const next: StagedImage[] = [];
      for (const f of accept) {
        if (!ACCEPTED_MIMES.includes(f.type)) {
          setImageError(`"${f.name}" is not a supported image type.`);
          continue;
        }
        if (f.size > MAX_IMAGE_BYTES) {
          setImageError(
            `"${f.name}" is over 5 MB — Anthropic's per-image cap.`,
          );
          continue;
        }
        try {
          const dataB64 = await fileToBase64(f);
          next.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            mediaType: f.type,
            dataB64,
            previewUrl: URL.createObjectURL(f),
            name: f.name,
            size: f.size,
          });
        } catch (err) {
          setImageError(
            err instanceof Error ? err.message : "Failed to read image",
          );
        }
      }
      setImages((prev) => [...prev, ...next]);
      if (dropped > 0) {
        setImageError(
          `Only ${MAX_IMAGES} images allowed; dropped ${dropped} extra.`,
        );
      }
    },
    [images.length],
  );

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  // Clipboard paste — when the operator focuses the dialog and pastes a
  // screenshot, capture it as an image attachment. Limited to image/* items
  // so a plain-text paste in the description textarea still works normally.
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  }

  async function handleDraft() {
    if (!description.trim()) return;
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch("/api/formats/draft-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          brand,
          parentFormatId: parentFormatId ?? null,
          images: images.map((img) => ({
            mediaType: img.mediaType,
            dataB64: img.dataB64,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft(json as DraftedFormat);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setDrafting(false);
    }
  }

  async function handleCreate() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          brand,
          instructions: draft.instructions,
          parentFormatId: draft.suggestedParentFormatId,
          isClippableFormat: true,
          clipTargetPostType: draft.suggestedPostType,
          clipTargetPlatform: draft.suggestedPlatform,
          clipAspectRatio: draft.suggestedAspectRatio,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(`Created "${draft.name}"`);
      onCreated?.(json.id as string);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Quick add format
            <Badge variant="outline" className="ml-2 text-[10px]">
              AI-drafted
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {stage === "input" && (
          <div className="space-y-4" onPaste={handlePaste}>
            <div className="space-y-2">
              <Label htmlFor="qa-description">
                Describe your new clip format
              </Label>
              <Textarea
                id="qa-description"
                rows={3}
                placeholder="A Reel that reveals the founder's exact tech stack as a numbered list overlay. Only applies to videos where the speaker walks through the tools and stack they use."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                One or two sentences. The AI drafts the full Skill markdown
                (hook style, anti-patterns, Descript layout, cross-post rules)
                + suggests post type and aspect ratio. You'll see the result
                before anything is saved.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">
                Reference screenshots{" "}
                <span className="font-normal text-muted-foreground">
                  (optional, up to {MAX_IMAGES})
                </span>
              </Label>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={
                  "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-5 text-center cursor-pointer transition-colors " +
                  (dragOver
                    ? "border-foreground bg-accent/50"
                    : "border-input hover:bg-accent/30")
                }
              >
                <ImagePlusIcon className="size-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  Drag in, paste, or click to attach screenshots. Claude
                  reads them to extract layout, on-screen text, and the
                  format&apos;s structure.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_MIMES.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      void addFiles(e.target.files);
                      e.target.value = "";
                    }
                  }}
                />
              </div>
              {images.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {images.map((img) => (
                    <div
                      key={img.id}
                      className="relative group rounded-md overflow-hidden border border-border bg-muted"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.previewUrl}
                        alt={img.name}
                        className="block w-full aspect-video object-cover"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeImage(img.id);
                        }}
                        className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground hover:bg-background shadow-sm"
                        aria-label={`Remove ${img.name}`}
                      >
                        <XIcon className="size-3" />
                      </button>
                      <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">
                        {img.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {imageError && (
                <p className="text-xs text-amber-600">{imageError}</p>
              )}
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={drafting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleDraft()}
                disabled={drafting || description.trim().length === 0}
              >
                {drafting
                  ? "Drafting…"
                  : images.length > 0
                    ? `Draft format from text + ${images.length} screenshot${images.length === 1 ? "" : "s"}`
                    : "Draft format"}
              </Button>
            </div>
          </div>
        )}

        {stage === "review" && draft && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="qa-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="qa-name"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="qa-post-type" className="text-xs">
                  Target post type
                </Label>
                <select
                  id="qa-post-type"
                  value={draft.suggestedPostType}
                  onChange={(e) =>
                    setDraft({ ...draft, suggestedPostType: e.target.value })
                  }
                  className="block w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                >
                  <option value="instagram_reel">instagram_reel</option>
                  <option value="tiktok">tiktok</option>
                  <option value="youtube_shorts">youtube_shorts</option>
                  <option value="x">x</option>
                  <option value="instagram_post">instagram_post</option>
                  <option value="linkedin">linkedin</option>
                  <option value="threads">threads</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="qa-platform" className="text-xs">
                  Target platform(s)
                </Label>
                <Input
                  id="qa-platform"
                  value={draft.suggestedPlatform.join(", ")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      suggestedPlatform: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    })
                  }
                  placeholder="Instagram Reel"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="qa-aspect" className="text-xs">
                  Clip aspect ratio
                </Label>
                <select
                  id="qa-aspect"
                  value={draft.suggestedAspectRatio}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      suggestedAspectRatio: e.target.value as "9:16" | "16:9",
                    })
                  }
                  className="block w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                >
                  <option value="9:16">9:16 (vertical)</option>
                  <option value="16:9">16:9 (horizontal)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="qa-instructions" className="text-xs">
                Skill (markdown)
              </Label>
              <Textarea
                id="qa-instructions"
                value={draft.instructions}
                onChange={(e) =>
                  setDraft({ ...draft, instructions: e.target.value })
                }
                rows={18}
                className="font-mono text-[12px] leading-snug"
              />
              <p className="text-[11px] text-muted-foreground">
                Edit any section before saving. The agent already added the
                canonical headings — keep them in place so downstream
                extractors (Descript, Cross Post Rules) work correctly.
              </p>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStage("input");
                  setError(null);
                }}
                disabled={saving}
              >
                ← Re-draft
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={saving || !draft.name.trim()}
                >
                  {saving ? "Saving…" : "Create format"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
