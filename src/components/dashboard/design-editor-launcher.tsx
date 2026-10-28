"use client";

/** Content-detail entry to the in-app design editor, for the same items the
 *  queue's TriageDialog opens it on: `designEditor` flag, repurposed, and a
 *  format with a design template. Without this a manual repurpose (Actions →
 *  Repurpose → <format>) lands on the classic page with no way into the
 *  editor until a render exists. `?design=1` (set by that create flow) opens
 *  it on arrival. Renders nothing for anyone/anything else. */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { PaletteIcon } from "lucide-react";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { useDesignTemplates } from "@/components/design-editor/use-design-templates";
import { readUrlParam, replaceUrlParam } from "./use-dialog-url";
import { useCanEditBrand } from "@/components/brand-access";

const DesignEditorDialog = dynamic(
  () => import("@/components/design-editor/design-editor-dialog").then((m) => m.DesignEditorDialog),
  { ssr: false },
);

export function DesignEditorLauncher({
  item,
  onDone,
}: {
  item: { id: string; brand: string; sourceType: string | null; format: string | null };
  onDone: () => void;
}) {
  const flags = useFeatureFlags();
  const templates = useDesignTemplates(!!flags?.designEditor, item.brand);
  const [open, setOpen] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const autoOpened = useRef(false);
  // The design editor only edits/renders — view-only users get the button
  // disabled and no ?design=1 auto-open.
  const canEdit = useCanEditBrand(item.brand);
  const eligible =
    !!flags?.designEditor &&
    item.sourceType === "repurposed" &&
    !!item.format &&
    !!templates?.has(item.format) &&
    !unsupported;

  useEffect(() => {
    if (!eligible || !canEdit || autoOpened.current || readUrlParam("design") !== "1") return;
    autoOpened.current = true;
    replaceUrlParam("design", null);
    setOpen(true);
  }, [eligible, canEdit]);

  if (!eligible) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!canEdit}
        title={canEdit ? undefined : "View only — you don't have edit access to this brand"}
        className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PaletteIcon className="size-3" aria-hidden />
        Open design editor
      </button>
      {open && (
        <DesignEditorDialog
          open={open}
          onOpenChange={setOpen}
          productionItemId={item.id}
          brand={item.brand}
          onDone={onDone}
          onUnsupported={(message) => {
            setOpen(false);
            setUnsupported(true);
            if (message) toast.message("Opening the classic view", { description: message });
          }}
        />
      )}
    </>
  );
}
