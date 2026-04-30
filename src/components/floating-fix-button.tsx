"use client";

import { useState } from "react";
import { toast } from "sonner";
import { WrenchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const CATEGORIES = [
  { value: "", label: "(none)" },
  { value: "ui", label: "UI" },
  { value: "data_wrong", label: "Data wrong" },
  { value: "automation", label: "Automation" },
  { value: "idea", label: "Idea" },
  { value: "other", label: "Other" },
] as const;

const HTML_CAP = 2_000_000;

// Floating fix-filing button. Renders bottom-right of every dashboard page
// (admin-gated by the layout). On open it snapshots the URL and the full
// rendered DOM so /fixthings has the page context Pat was looking at when
// he hit the button — no separate "which page?" dropdown needed.
export function FloatingFixButton() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setNote("");
    setCategory("");
    setFiles([]);
  }

  async function uploadOne(file: File): Promise<string> {
    const presign = await fetch("/api/fixes/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || "image/png",
        contentLength: file.size,
      }),
    });
    if (!presign.ok) {
      const j = await presign.json().catch(() => ({}));
      throw new Error(j.error || "Failed to get upload URL");
    }
    const { url, key } = (await presign.json()) as { url: string; key: string };
    const put = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": file.type || "image/png" },
      body: file,
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return key;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      toast.error("Add a note describing what to fix.");
      return;
    }

    setSubmitting(true);
    try {
      // Capture URL + rendered DOM at submit time so the snapshot reflects
      // current state (incl. JS-rendered content). Wrapped defensively so a
      // capture failure never blocks filing.
      const url = typeof window !== "undefined" ? window.location.href : "";
      let pageHtml: string | null = null;
      try {
        if (typeof document !== "undefined") {
          pageHtml = document.documentElement.outerHTML.slice(0, HTML_CAP);
        }
      } catch {
        pageHtml = null;
      }

      const photoKeys: string[] = [];
      for (const file of files) {
        photoKeys.push(await uploadOne(file));
      }

      const res = await fetch("/api/fixes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: note.trim(),
          category: category || null,
          url,
          pageHtml,
          photoKeys,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to file fix");
      }

      toast.success("Fix queued. I'll work through these.");
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to file fix");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="File a fix"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-amber-600 text-white shadow-lg transition-colors hover:bg-amber-700"
      >
        <WrenchIcon className="h-5 w-5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Fix something</DialogTitle>
            <DialogDescription>
              Tell me what&apos;s broken or missing. I&apos;ll capture this
              page&apos;s URL + DOM so /fixthings has context.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="fix-category" className="mb-1 block">
                Category
              </Label>
              <select
                id="fix-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="fix-note" className="mb-1 block">
                What should be fixed?
              </Label>
              <Textarea
                id="fix-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. cross-post recommender skipped this video; suggested rule should fire."
                rows={4}
                required
                disabled={submitting}
                autoFocus
              />
            </div>

            <div>
              <Label htmlFor="fix-photos" className="mb-1 block">
                Screenshots
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  optional
                </span>
              </Label>
              <input
                id="fix-photos"
                type="file"
                accept="image/*"
                multiple
                disabled={submitting}
                onChange={(e) =>
                  setFiles(e.target.files ? Array.from(e.target.files) : [])
                }
                className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-amber-50 file:px-3 file:py-1 file:text-xs file:font-medium file:text-amber-700 hover:file:bg-amber-100"
              />
              {files.length > 0 ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {files.length} file{files.length === 1 ? "" : "s"} selected
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting || !note.trim()}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                {submitting ? "Filing…" : "File fix"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
