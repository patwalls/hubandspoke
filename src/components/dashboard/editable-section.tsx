"use client";

// One section of a newsletter preview on the editor's canvas: hover outlines
// it, click selects it (its controls show in the editor's side panel) and, for
// a text section, opens its Markdown for typing right where it is. Shared by
// both previews (HubSpot templates and the beehiiv card layout) so every
// newsletter edits the same way. The editor owns all state (PreviewEditing).

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PreviewEditing {
  /** The selected section key, or `shot:<markKey>`. */
  selected: string | null;
  /** The section whose text is open in place. */
  editingSection: string | null;
  regenerating: string[];
  onSelectSection: (key: string) => void;
  onChangeSection: (key: string, markdown: string) => void;
  onDoneEditing: () => void;
  onSelectShot: (sectionKey: string, markKey: string) => void;
  onDropShot: (sectionKey: string, markKey: string, file: File) => void;
}

export function EditableSection({
  sectionKey,
  markdown,
  isSponsor,
  edit,
  children,
}: {
  sectionKey: string;
  /** The section's raw Markdown (what the textarea edits). */
  markdown: string;
  /** The sponsor section is edited in the side panel, not in place. */
  isSponsor: boolean;
  edit: PreviewEditing;
  /** The rendered section (or a "click to write" hint when empty). */
  children: ReactNode;
}) {
  const regenerating = edit.regenerating.includes(sectionKey);
  if (edit.editingSection === sectionKey && !isSponsor && !regenerating) {
    return (
      <textarea
        autoFocus
        value={markdown}
        onChange={(e) => edit.onChangeSection(sectionKey, e.target.value)}
        onBlur={edit.onDoneEditing}
        onClick={(e) => e.stopPropagation()}
        className="-mx-2 my-2 block min-h-24 w-[calc(100%+1rem)] resize-none rounded-md bg-white px-2 py-1.5 text-[15px] leading-[1.6] text-[#222222] outline-2 outline-[#49adff] outline-solid [field-sizing:content]"
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => edit.onSelectSection(sectionKey)}
      // Links in the preview don't navigate while editing.
      onClickCapture={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && edit.onSelectSection(sectionKey)}
      title={isSponsor ? "Click to edit the sponsor section" : "Click to edit"}
      className={cn(
        "relative -mx-2 rounded-md px-2 [&_a]:cursor-text",
        isSponsor ? "cursor-pointer" : "cursor-text",
        edit.selected === sectionKey ? "outline-2 outline-[#49adff] outline-solid" : "hover:outline-2 hover:outline-dashed hover:outline-[#49adff]/60",
        regenerating && "pointer-events-none opacity-50",
      )}
    >
      {regenerating && (
        <span className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[11px] text-[#222] shadow">
          <Loader2 className="size-3 animate-spin" /> Rewriting…
        </span>
      )}
      {children}
    </div>
  );
}

/** What an empty section shows on the canvas. */
export function emptySectionHint(hint: string | undefined) {
  return <p style={{ margin: "12px 0", fontSize: 14, fontStyle: "italic", color: "#9ca3af" }}>Click to write this section{hint ? `: ${hint}` : ""}</p>;
}
