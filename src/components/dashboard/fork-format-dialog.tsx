"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GitBranchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface DraftedFormat {
  name: string;
  instructions: string;
  suggestedPostType: string;
  suggestedPlatform: string[];
  suggestedAspectRatio: "9:16" | "16:9";
  suggestedParentFormatId: string | null;
  inheritedIsClippable?: boolean;
  inheritedIsCanva?: boolean;
  inheritedLabelsAsOriginal?: boolean;
}

interface Props {
  brand: string;
  /** The format being forked — becomes the new format's parent. */
  parentFormatId: string;
  parentFormatName: string;
  /** The item whose content grounds the narrowing + gets reassigned. */
  productionItemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the new format is created AND assigned to the item. */
  onForked?: (formatId: string, formatName: string) => void;
}

/**
 * Fork a more-specific format off the one a piece of content already has.
 *
 * The operator names the new format and (optionally) notes what makes it more
 * specific. Haiku takes the *parent format's existing Skill* + this item's
 * content and drafts a NARROWED Skill (fork mode of /api/formats/draft-skill).
 * The operator reviews/edits, then "Create & assign" creates the child format
 * (parented under the source, inheriting its clip settings) and reassigns the
 * item to it — mirroring the two-stage Quick-add flow.
 */
export function ForkFormatDialog({
  brand,
  parentFormatId,
  parentFormatName,
  productionItemId,
  open,
  onOpenChange,
  onForked,
}: Props) {
  const [stage, setStage] = useState<"input" | "review">("input");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftedFormat | null>(null);

  function reset() {
    setStage("input");
    setName("");
    setNote("");
    setDraft(null);
    setError(null);
    setDrafting(false);
    setSaving(false);
  }

  async function handleDraft() {
    if (!name.trim()) return;
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch("/api/formats/draft-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          forkFromFormatId: parentFormatId,
          productionItemId,
          name: name.trim(),
          description: note.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      // Prefer the operator's typed name over the LLM's suggestion.
      setDraft({ ...(json as DraftedFormat), name: name.trim() });
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setDrafting(false);
    }
  }

  async function handleCreateAndAssign() {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // 1. Create the child format under the source format.
      const createRes = await fetch("/api/formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          brand,
          instructions: draft.instructions,
          parentFormatId,
          isClippableFormat: draft.inheritedIsClippable ?? true,
          isCanvaFormat: draft.inheritedIsCanva ?? false,
          labelsAsOriginal: draft.inheritedLabelsAsOriginal ?? false,
          clipTargetPostType: draft.suggestedPostType,
          clipTargetPlatform: draft.suggestedPlatform,
          clipAspectRatio: draft.suggestedAspectRatio,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        setError(created?.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const newName: string = created.name ?? draft.name.trim();

      // 2. Reassign this item to the new format.
      const assignRes = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productionItemId, format: newName }),
      });
      if (!assignRes.ok) {
        const j = await assignRes.json().catch(() => ({}));
        // The format exists now — assignment just didn't stick. Make that clear.
        setError(
          `Created "${newName}" but failed to assign it: ${j?.error ?? `HTTP ${assignRes.status}`}`,
        );
        return;
      }

      toast.success(`Forked "${parentFormatName}" → "${newName}" and assigned it`);
      onForked?.(created.id as string, newName);
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
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" />
            Fork format
            <Badge variant="outline" className="text-[10px]">
              AI-drafted
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Forking{" "}
            <span className="font-medium text-foreground">
              {parentFormatName}
            </span>{" "}
            into a narrower format, specialized for this piece of content.
          </DialogDescription>
        </DialogHeader>

        {stage === "input" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fork-name">New format name</Label>
              <Input
                id="fork-name"
                placeholder="e.g. Reel: Repackage Tech-Stack Walkthrough"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fork-note">
                What makes this more specific?{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="fork-note"
                rows={3}
                placeholder="Only applies to videos where the founder walks through their exact tech stack and tools. Hook should tease the stack reveal."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                The AI starts from{" "}
                <span className="font-medium">{parentFormatName}</span>&apos;s
                Skill and this item&apos;s content, then narrows it. Leave the
                note blank to let it infer the angle from the content alone.
                You&apos;ll review the result before anything is saved.
              </p>
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
                disabled={drafting || name.trim().length === 0}
              >
                {drafting ? "Drafting…" : "Draft fork"}
              </Button>
            </div>
          </div>
        )}

        {stage === "review" && draft && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="fork-review-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="fork-review-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fork-post-type" className="text-xs">
                  Target post type
                </Label>
                <select
                  id="fork-post-type"
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
                <Label htmlFor="fork-platform" className="text-xs">
                  Target platform(s)
                </Label>
                <Input
                  id="fork-platform"
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
                <Label htmlFor="fork-aspect" className="text-xs">
                  Clip aspect ratio
                </Label>
                <select
                  id="fork-aspect"
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
              <Label htmlFor="fork-instructions" className="text-xs">
                Skill (markdown)
              </Label>
              <Textarea
                id="fork-instructions"
                value={draft.instructions}
                onChange={(e) =>
                  setDraft({ ...draft, instructions: e.target.value })
                }
                rows={18}
                className="font-mono text-[12px] leading-snug"
              />
              <p className="text-[11px] text-muted-foreground">
                Specialized from {parentFormatName}. Keep the canonical headings
                in place so downstream extractors (Descript, Cross Post Rules)
                work.
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
                  onClick={() => void handleCreateAndAssign()}
                  disabled={saving || !draft.name.trim()}
                >
                  {saving ? "Saving…" : "Create & assign"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
