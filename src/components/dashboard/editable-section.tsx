"use client";

// One section of a newsletter preview on the editor's canvas: hover outlines
// it, click selects it (its controls show in the editor's side panel) and, for
// a text section, opens its Markdown for typing right where it is. Shared by
// both previews (HubSpot templates and the beehiiv card layout) so every
// newsletter edits the same way. The editor owns all state (PreviewEditing).
// The same canvas serves the template editor (mode "template"): clicking a
// section edits its instructions instead of its text. Fixed parts of the
// email (masthead, footer, labels and headings the template sets) render
// through FixedPart: locked with a note in a draft, selectable in the
// template editor when the template owns them. While typing a draft, a
// selection gets a small Bold / Italic toolbar (and Cmd+B / Cmd+I), and
// images show as short "[🖼 …]" tokens instead of their URLs.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bold, Italic, Loader2, Lock, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { collapseImages, expandImages, toggleInline, type InlineMark } from "@/lib/markdown-format";

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
  /** Template editor: the template is locked (structure can't change; FixedParts show a lock). */
  structureLocked?: boolean;
  /** Template editor: a beehiiv card, or the email's look (masthead, images, poll), was clicked. */
  onSelectCard?: (index: number) => void;
  onSelectLook?: () => void;
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
  if (edit.editingSection === sectionKey && (!isSponsor || edit.mode === "template") && !regenerating) {
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
      <DraftTextBox markdown={markdown} onChange={(md) => edit.onChangeSection(sectionKey, md)} onDone={edit.onDoneEditing} />
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
      title={edit.mode === "template" ? "Click to edit what the drafter writes here" : isSponsor ? "Click to edit the sponsor section" : "Click to edit"}
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
      {edit.mode === "template" && <FillBadge isSponsor={isSponsor} />}
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

/** Apply bold/italic to a textarea's selection; returns the new value, and puts the selection back after React re-renders. */
export function useInlineFormat() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (pending.current && ref.current) {
      ref.current.setSelectionRange(...pending.current);
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
  return { ref, apply };
}

/** A draft section open for typing: images as tokens, and a Bold / Italic toolbar on a selection. */
function DraftTextBox({ markdown, onChange, onDone }: { markdown: string; onChange: (md: string) => void; onDone: () => void }) {
  // One token map per editing session (the box remounts each time it opens).
  const [tokens] = useState(() => new Map<string, string>());
  const text = collapseImages(markdown, tokens);
  const { ref, apply } = useInlineFormat();
  const [hasSelection, setHasSelection] = useState(false);
  const format = (mark: InlineMark) => {
    const next = apply(text, mark);
    if (next != null) onChange(expandImages(next, tokens));
  };
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      {hasSelection && (
        <div className="absolute -top-9 right-0 z-20 flex items-center gap-0.5 rounded-md border bg-white p-0.5 shadow-md">
          {(
            [
              ["**", Bold, "Bold (⌘B)"],
              ["*", Italic, "Italic (⌘I)"],
            ] as const
          ).map(([mark, Icon, title]) => (
            <button
              key={mark}
              type="button"
              title={title}
              // Keep the text box focused (a blur would close it).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format(mark)}
              className="flex size-7 items-center justify-center rounded text-[#222] hover:bg-[#eef6ff]"
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        autoFocus
        value={text}
        onChange={(e) => onChange(expandImages(e.target.value, tokens))}
        onSelect={(e) => setHasSelection(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd)}
        onKeyDown={(e) => {
          const mark = formatShortcut(e);
          if (!mark) return;
          e.preventDefault();
          format(mark);
        }}
        onBlur={onDone}
        className={TEXTAREA}
      />
    </div>
  );
}

/** Template editor: who fills this section in each issue. */
function FillBadge({ isSponsor }: { isSponsor: boolean }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#eef6ff] px-2 py-0.5 text-[11px] font-medium leading-normal text-[#2563eb]">
      <Sparkles className="size-3" />
      {isSponsor ? "Filled from Asana each issue (the sponsor's copy)" : "AI writes this each draft, from these instructions"}
    </span>
  );
}

/**
 * A fixed part of the email. Draft: locked, with `reason` on hover (it comes
 * from the template or the email tool, not the draft). Template editor: with
 * `onSelect` it's selectable (the template owns it); without, locked too.
 * `lockedInTemplate`: selectable in the template editor (to see its settings)
 * but its settings are locked there too — the lock shows on hover with why.
 */
export function FixedPart({
  edit,
  reason,
  onSelect,
  lockedInTemplate,
  block = true,
  children,
}: {
  edit?: PreviewEditing;
  reason: string;
  onSelect?: () => void;
  lockedInTemplate?: string | null;
  block?: boolean;
  children: ReactNode;
}) {
  if (!edit) return <>{children}</>;
  const Tag = block ? "div" : "span";
  const templateLock = edit.mode === "template" ? (lockedInTemplate ?? (edit.structureLocked ? "Locked template: contact Sam to change this" : null)) : null;
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
        title={templateLock ?? undefined}
        className={cn("group/fixed relative cursor-pointer rounded-md hover:outline-2 hover:outline-dashed hover:outline-[#49adff]/60", !block && "inline-block")}
      >
        {children}
        {templateLock && <LockChip text={templateLock} />}
      </Tag>
    );
  }
  return (
    <Tag title={reason} onClick={(e) => e.stopPropagation()} className={cn("group/fixed relative cursor-default", !block && "inline-block")}>
      {children}
      <LockChip text={reason} />
    </Tag>
  );
}

function LockChip({ text }: { text: string }) {
  return (
    <span className="pointer-events-none absolute right-1 top-1 z-10 hidden max-w-[80%] items-center gap-1 rounded bg-white/95 px-1.5 py-0.5 text-[10px] font-normal leading-normal text-[#6b7280] shadow group-hover/fixed:flex">
      <Lock className="size-3 shrink-0" /> {text}
    </span>
  );
}

/** What an empty section shows on the canvas. */
export function emptySectionHint(hint: string | undefined) {
  return <p style={{ margin: "12px 0", fontSize: 14, fontStyle: "italic", color: "#9ca3af" }}>Click to write this section{hint ? `: ${hint}` : ""}</p>;
}
