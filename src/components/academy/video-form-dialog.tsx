"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { learnPointsToLines, linesToLearnPoints, linesToList } from "@/lib/academy/form-text";
import { videoEmbedUrl } from "@/lib/academy/video-embed";
import { GuideEditor } from "@/components/academy/guide-editor";
import type { AcademyCategory, AcademyVideo } from "@/lib/academy/queries";

const NEW_CATEGORY = "__new__";

/**
 * Add or edit an Academy video. Lists are plain text, one item per line, so
 * editing needs no special format (see src/lib/academy/form-text.ts).
 */
export function VideoFormDialog({
  categories,
  video,
  defaultCategoryId,
  onClose,
}: {
  categories: Pick<AcademyCategory, "id" | "name">[];
  video?: AcademyVideo;
  defaultCategoryId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(video?.title ?? "");
  const [categoryId, setCategoryId] = useState(
    video?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? NEW_CATEGORY,
  );
  const [newCategory, setNewCategory] = useState("");
  const [videoUrl, setVideoUrl] = useState(video?.videoUrl ?? "");
  const [durationLabel, setDurationLabel] = useState(video?.durationLabel ?? "");
  const [summary, setSummary] = useState(video?.summary ?? "");
  const [learn, setLearn] = useState(learnPointsToLines(video?.learnPoints ?? []));
  const [actions, setActions] = useState((video?.actionItems ?? []).join("\n"));
  const [notes, setNotes] = useState(video?.notes ?? "");
  const [comingSoon, setComingSoon] = useState(video?.comingSoon ?? false);
  const [saving, setSaving] = useState(false);

  const urlLooksUnsupported = videoUrl.trim() !== "" && videoEmbedUrl(videoUrl) === null;

  async function save() {
    if (!title.trim()) return toast.error("Give the video a title");
    setSaving(true);
    try {
      let catId = categoryId;
      if (catId === NEW_CATEGORY) {
        if (!newCategory.trim()) {
          toast.error("Name the new category");
          return;
        }
        const res = await fetch("/api/academy/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newCategory }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't create the category");
        catId = data.category.id;
      }

      const res = await fetch(video ? `/api/academy/videos/${video.id}` : "/api/academy/videos", {
        method: video ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: catId,
          title,
          summary,
          videoUrl,
          durationLabel,
          learnPoints: linesToLearnPoints(learn),
          actionItems: linesToList(actions),
          notes,
          comingSoon,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save the video");
      toast.success(video ? "Video updated" : "Video added");
      onClose();
      router.push(`/academy/${data.video.slug}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the video");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{video ? "Edit video" : "Add a video"}</DialogTitle>
          <DialogDescription>Everyone in Hub &amp; Spoke can watch it. Only Academy editors (Sam, Pat, Evgeny) can change it.</DialogDescription>
        </DialogHeader>

        {/* Fields are in the same order they appear on the video page. */}
        <div className="grid gap-4">
          <Field label="Category">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </select>
            {categoryId === NEW_CATEGORY && (
              <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category name" />
            )}
          </Field>

          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Set Up Your Brand & Accounts" autoFocus />
            <label className="flex cursor-pointer items-start gap-2 pt-1 text-sm">
              <input type="checkbox" checked={comingSoon} onChange={(e) => setComingSoon(e.target.checked)} className="mt-0.5 size-4 accent-orange-500" />
              <span>
                <span className="font-medium">Coming soon</span>
                <span className="block text-xs text-muted-foreground">
                  Listed with a &ldquo;Coming soon&rdquo; label but can&apos;t be watched yet. Untick it when the video&apos;s ready and it shows as &ldquo;New&rdquo;.
                </span>
              </span>
            </label>
          </Field>

          <Field label="Short description" hint="One line under the title — also shown on the library card">
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Connect your accounts and get the basics in place." />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <Field label="Main video link" hint="Loom, YouTube, Vimeo or Google Drive share link">
              <Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://www.loom.com/share/…" />
              {urlLooksUnsupported && (
                <p className="text-xs text-amber-600">This link won&apos;t show a player — viewers will get an &ldquo;Open video&rdquo; link instead.</p>
              )}
            </Field>
            <Field label="Length" hint="Optional">
              <Input value={durationLabel} onChange={(e) => setDurationLabel(e.target.value)} placeholder="~5 min" />
            </Field>
          </div>

          <Field label="In this video, you'll learn" hint="One point per line. Start a line with a timestamp (0:18) to make it clickable.">
            <Textarea
              rows={5}
              value={learn}
              onChange={(e) => setLearn(e.target.value)}
              placeholder={"0:18 What is Hub & Spoke\n1:09 How to use Hub & Spoke for data & metrics"}
            />
          </Field>

          <Field label="Action items" hint="One per line — shown as a checklist viewers tick off after watching.">
            <Textarea
              rows={4}
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder={"Upload your brand assets + watermarks\nCreate your production goals"}
            />
          </Field>

          <Field label="Step-by-step guide" hint="Optional. Shown below the action items — use Step headings, screenshots, tip boxes and extra videos.">
            <GuideEditor value={notes} onChange={setNotes} />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : video ? "Save changes" : "Add video"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
