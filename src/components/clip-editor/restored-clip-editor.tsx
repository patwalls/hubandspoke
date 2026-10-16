"use client";

/**
 * `?clip=<id>` on the Repurposed queue when no row can open it — a video
 * post on X made from a candidate takes that candidate off the queue the
 * moment its item exists, so the link Pat sends (or reloads) has nothing to
 * attach to. Mount the editor detached; closing drops the params. Twin of
 * RestoredDesignEditor.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { useFeatureFlags } from "./use-feature-flags";
import { CLIP_PARAM } from "./drafts";
import { readUrlParam, replaceUrlParam } from "@/components/dashboard/use-dialog-url";

const ClipEditorDialog = dynamic(() => import("./clip-editor-dialog").then((m) => m.ClipEditorDialog), { ssr: false });

export function RestoredClipEditor({ brand, onDone }: { brand: string; onDone: () => void }) {
  const flags = useFeatureFlags();
  const [clipIdeaId, setClipIdeaId] = useState<string | null>(() => readUrlParam(CLIP_PARAM));
  const close = () => {
    replaceUrlParam(CLIP_PARAM, null);
    replaceUrlParam("candidate", null);
    setClipIdeaId(null);
  };
  if (!flags?.clipEditor || !clipIdeaId) return null;
  return (
    <ClipEditorDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      clipIdeaId={clipIdeaId}
      brand={brand}
      onDone={onDone}
      onUnsupported={() => {
        toast.message("Couldn't open that post here", { description: "It may have been killed or finished elsewhere." });
        close();
      }}
    />
  );
}
