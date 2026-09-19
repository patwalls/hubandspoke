"use client";

/**
 * `?item=<id>` on the Repurposed queue when no row can open it — the design
 * item moved to In Production the moment it was created, so the link Pat
 * sends (or reloads) has nothing to attach to. Mount the editor detached.
 * Closing drops the params (no history entry was pushed on a fresh load).
 * Flag-only: only the design editor can open an item by id from here.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { readUrlParam, replaceUrlParam } from "@/components/dashboard/use-dialog-url";

const DesignEditorDialog = dynamic(() => import("./design-editor-dialog").then((m) => m.DesignEditorDialog), { ssr: false });

export function RestoredDesignEditor({ brand, onDone }: { brand: string; onDone: () => void }) {
  const flags = useFeatureFlags();
  const [itemId, setItemId] = useState<string | null>(() => readUrlParam("item"));
  const close = () => {
    replaceUrlParam("item", null);
    replaceUrlParam("candidate", null);
    setItemId(null);
  };
  if (!flags?.designEditor || !itemId) return null;
  return (
    <DesignEditorDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      productionItemId={itemId}
      brand={brand}
      onDone={onDone}
      onUnsupported={(message) => {
        toast.message("Couldn't open that post here", { description: message ?? "It may not be a design-editor post." });
        close();
      }}
    />
  );
}
