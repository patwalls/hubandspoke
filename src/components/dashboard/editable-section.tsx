"use client";

// One section of a newsletter preview on the editor's canvas: hover outlines
// it, click selects it (its controls show in the editor's side panel) and, for
// a text section, opens its Markdown for typing right where it is. Every
// newsletter (HubSpot and beehiiv) edits the same way. The editor owns all state (PreviewEditing).
// The same canvas serves the template editor (mode "template"): clicking a
// section edits its instructions instead of its text. Fixed parts of the
// email (masthead, footer, labels and headings the template sets) render
// through FixedPart: a note on hover in a draft (it comes from the design),
// selectable in the template editor. A draft section opens in a
// WYSIWYG editor (rich-section-editor.tsx) that looks like the email — no
// Markdown on screen.

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { LayoutTemplate, Loader2, Megaphone, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleInline, type Edited, type InlineMark } from "@/lib/markdown-format";
import { screenshotKey } from "@/lib/newsletter-screenshots";
import { RichSectionEditor } from "@/components/dashboard/rich-section-editor";

export interface PreviewEditing {
  /** "draft" (default): edit drafted text. "template": edit each section's instructions. */
  mode?: "draft" | "template";
  /** The selected section key, `shot:<markKey>`, `card:<index>` or `look`. */
  selected: string | null;
  /** The section whose text is open in place. */
  editingSection: string | null;
  regenerating: string[];
  onSelectSection: (key: string) => void;
  onChangeSection: (key: string, markdown: string) => void;
  onDoneEditing: () => void;
  onSelectShot: (sectionKey: string, markKey: string) => void;
  onDropShot: (sectionKey: string, markKey: string, file: File) => void;
  /** Draft: an image in a section's text (the video thumbnail, or any other) was clicked / had a file dropped on it. `index` = its order in the section. */
  onSelectImage?: (sectionKey: string, index: number) => void;
  onDropImage?: (sectionKey: string, index: number, file: File) => void;
  /** Draft: the trash icon on a screenshot / an image — take it out of the text entirely. */
  onDeleteShot?: (sectionKey: string, markKey: string) => void;
  onRemoveImage?: (sectionKey: string, index: number) => void;
  /** Draft: "+ Add screenshot" under step `n` of a section with screenshots (`busy`: which one is being added, as "<sectionKey>:<n>"). */
  onAddShot?: (sectionKey: string, n: number) => void;
  addingShot?: string | null;
  /** Draft: the picked image for a screenshot spot (the in-place editor shows it). */
  shotUrl?: (sectionKey: string, label: string) => string | null;
  /** Draft: open the format's template (clicking a designed, fixed part). */
  onEditTemplate?: () => void;
  /** Draft: replace `count` designed nodes at `path` of this issue's layout with `nodes` (an edit to a designed part, this issue only). */
  onChangeDesign?: (path: number[], nodes: import("@/lib/newsletter-rich-doc").DocNode[], count: number) => void;
}

export function EditableSection({
  sectionKey,
  markdown,
  isSponsor,
  edit,
  children,
}: {
  sectionKey: string;
  /** What the textarea edits: the section's Markdown (draft) or its instructions (template). */
  markdown: string;
  /** The sponsor section is edited in the side panel, not in place. */
  isSponsor: boolean;
  edit: PreviewEditing;
  /** The rendered section (or a "click to write" hint when empty). */
  children: ReactNode;
}) {
  const regenerating = edit.regenerating.includes(sectionKey);
  // The sponsor's copy comes from Asana in a draft; its instructions are still editable in the template.
  if (edit.editingSection === sectionKey && !regenerating) {
    return edit.mode === "template" ? (
      <textarea
        autoFocus
        value={markdown}
        onChange={(e) => edit.onChangeSection(sectionKey, e.target.value)}
        onBlur={edit.onDoneEditing}
        onClick={(e) => e.stopPropagation()}
        className={TEXTAREA}
      />
    ) : (
      <RichSectionEditor
        markdown={markdown}
        onChange={(md) => edit.onChangeSection(sectionKey, md)}
        onDone={edit.onDoneEditing}
        hooks={{
          shotUrl: (label) => edit.shotUrl?.(sectionKey, label) ?? null,
          onOpenShot: (label) => {
            edit.onDoneEditing();
            edit.onSelectShot(sectionKey, screenshotKey(sectionKey, label));
          },
          onOpenImage: (index) => {
            edit.onDoneEditing();
            edit.onSelectImage?.(sectionKey, index);
          },
        }}
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        edit.onSelectSection(sectionKey);
      }}
      // Links in the preview don't navigate while editing.
      onClickCapture={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && edit.onSelectSection(sectionKey)}
      title={edit.mode === "template" ? "Click to edit what the drafter writes here" : "Click to edit"}
      className={cn(
        "relative -mx-2 rounded-md px-2 [&_a]:cursor-text",
        "cursor-text",
        edit.selected === sectionKey ? "outline-2 outline-[#49adff] outline-solid" : "hover:outline-2 hover:outline-dashed hover:outline-[#49adff]/60",
        regenerating && "pointer-events-none opacity-50",
      )}
    >
      {regenerating && (
        <span className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[11px] text-[#222] shadow">
          <Loader2 className="size-3 animate-spin" /> Rewriting…
        </span>
      )}
      {edit.mode === "template" && <FillBadge isSponsor={isSponsor} />}
      {/* Marks the issue's ad on the canvas only: the sent email never carries it. */}
      {isSponsor && edit.mode !== "template" && (
        <span className="pointer-events-none absolute -top-2.5 right-2 z-10 inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-semibold uppercase leading-normal tracking-wide text-amber-950 shadow-sm">
          <Megaphone className="size-3" /> Ad
        </span>
      )}
      {children}
    </div>
  );
}

const TEXTAREA =
  "-mx-2 my-2 block min-h-24 w-[calc(100%+1rem)] resize-none rounded-md bg-white px-2 py-1.5 text-[15px] leading-[1.6] text-[#222222] outline-2 outline-[#49adff] outline-solid [field-sizing:content]";

/** Cmd/Ctrl+B and Cmd/Ctrl+I on a selection → the Markdown mark (shared with the text view's boxes). */
export function formatShortcut(e: KeyboardEvent<HTMLTextAreaElement>): InlineMark | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === "b" ? "**" : k === "i" ? "*" : null;
}

/** Apply bold/italic (or any edit) to a textarea's selection; returns the new value, and puts the selection back after React re-renders. */
export function useInlineFormat() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (pending.current && ref.current) {
      ref.current.setSelectionRange(...pending.current);
      ref.current.focus();
      pending.current = null;
    }
  });
  const apply = (value: string, mark: InlineMark): string | null => {
    const el = ref.current;
    if (!el || el.selectionStart === el.selectionEnd) return null;
    const r = toggleInline(value, el.selectionStart, el.selectionEnd, mark);
    pending.current = [r.start, r.end];
    return r.value;
  };
  /** Any selection-based edit (toolbar helpers in markdown-format.ts). */
  const edit = (value: string, fn: (value: string, start: number, end: number) => Edited): string | null => {
    const el = ref.current;
    if (!el) return null;
    const r = fn(value, el.selectionStart, el.selectionEnd);
    pending.current = [r.start, r.end];
    return r.value;
  };
  return { ref, apply, edit };
}

/** Template editor: who fills this section in each issue. */
function FillBadge({ isSponsor }: { isSponsor: boolean }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#eef6ff] px-2 py-0.5 text-[11px] font-medium leading-normal text-[#2563eb]">
      <Sparkles className="size-3" />
      {isSponsor ? "The ad: pasted in each issue (or pulled from Asana)" : "AI writes this each draft, from these instructions"}
    </span>
  );
}

/**
 * A fixed part of the email. Draft: `reason` on hover (it comes from the
 * template or the email tool, not the draft); with `onSelect`, a click opens
 * the template. Template editor: with `onSelect` it's selectable.
 */
export function FixedPart({
  edit,
  reason,
  onSelect,
  block = true,
  children,
}: {
  edit?: PreviewEditing;
  reason: string;
  onSelect?: () => void;
  block?: boolean;
  children: ReactNode;
}) {
  if (!edit) return <>{children}</>;
  const Tag = block ? "div" : "span";
  if (edit.mode === "template" && onSelect) {
    return (
      <Tag
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        className={cn("group/fixed relative cursor-pointer rounded-md hover:outline-2 hover:outline-dashed hover:outline-[#49adff]/60", !block && "inline-block")}
      >
        {children}
      </Tag>
    );
  }
  return (
    <Tag title={reason} onClick={(e) => e.stopPropagation()} className={cn("group/fixed relative cursor-default", !block && "inline-block")}>
      {children}
      <DesignChip text={reason} />
    </Tag>
  );
}

function DesignChip({ text }: { text: string }) {
  return (
    <span className="pointer-events-none absolute right-1 top-1 z-10 hidden max-w-[80%] items-center gap-1 rounded bg-white/95 px-1.5 py-0.5 text-[10px] font-normal leading-normal text-[#6b7280] shadow group-hover/fixed:flex">
      <LayoutTemplate className="size-3 shrink-0" /> {text}
    </span>
  );
}

/** What an empty section shows on the canvas. */
export function emptySectionHint(hint: string | undefined) {
  return <p style={{ margin: "12px 0", fontSize: 14, fontStyle: "italic", color: "#9ca3af" }}>Click to write this section{hint ? `: ${hint}` : ""}</p>;
}
