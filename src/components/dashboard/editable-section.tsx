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
import { AtSign, Bold, Camera, Heading2, Italic, Link2, List, ListOrdered, Loader2, Lock, Minus, Quote, RectangleHorizontal, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { collapseImages, expandImages, insertBlock, prefixLines, toggleInline, wrapLink, type Edited, type InlineMark } from "@/lib/markdown-format";

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

/** A toolbar button: keeps the text box focused (a blur would close it). */
function Btn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="flex size-7 items-center justify-center rounded text-[#222] hover:bg-[#eef6ff]">
      {children}
    </button>
  );
}
const Sep = () => <span className="mx-0.5 h-4 w-px bg-[#e5e7eb]" />;

/** The in-place text box's toolbar: inline marks, links, blocks, a button, an image spot, a personalization token. */
function Toolbar({ text, onChange, edit }: { text: string; onChange: (next: string) => void; edit: ReturnType<typeof useInlineFormat>["edit"] }) {
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const run = (fn: (value: string, start: number, end: number) => Edited) => {
    const next = edit(text, fn);
    if (next != null) onChange(next);
  };
  return (
    <div className="absolute -top-9 right-0 z-20 flex items-center gap-0.5 rounded-md border bg-white p-0.5 shadow-md" onMouseDown={(e) => e.stopPropagation()}>
      {linkUrl !== null ? (
        <form
          className="flex items-center gap-1 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (linkUrl.trim()) run((v, s0, e0) => wrapLink(v, s0, e0, linkUrl.trim()));
            setLinkUrl(null);
          }}
        >
          <Link2 className="size-3.5 text-[#6b7280]" />
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setLinkUrl(null)}
            placeholder="https://…"
            className="h-6 w-56 rounded border px-1.5 text-[12px] outline-none focus:border-[#49adff]"
          />
          <button type="submit" className="rounded bg-[#49adff] px-2 py-0.5 text-[11px] font-medium text-white">
            Link
          </button>
        </form>
      ) : (
        <>
          <Btn title="Bold (⌘B)" onClick={() => run((v, s0, e0) => toggleInline(v, s0, e0, "**"))}>
            <Bold className="size-4" />
          </Btn>
          <Btn title="Italic (⌘I)" onClick={() => run((v, s0, e0) => toggleInline(v, s0, e0, "*"))}>
            <Italic className="size-4" />
          </Btn>
          <Btn title="Link the selected words" onClick={() => setLinkUrl("")}>
            <Link2 className="size-4" />
          </Btn>
          <Sep />
          <Btn title="Heading" onClick={() => run((v, s0, e0) => prefixLines(v, s0, e0, "## "))}>
            <Heading2 className="size-4" />
          </Btn>
          <Btn title="Bulleted list" onClick={() => run((v, s0, e0) => prefixLines(v, s0, e0, "- "))}>
            <List className="size-4" />
          </Btn>
          <Btn title="Numbered list" onClick={() => run((v, s0, e0) => prefixLines(v, s0, e0, (i) => `${i + 1}. `))}>
            <ListOrdered className="size-4" />
          </Btn>
          <Btn title="Quote" onClick={() => run((v, s0, e0) => prefixLines(v, s0, e0, "> "))}>
            <Quote className="size-4" />
          </Btn>
          <Sep />
          <Btn title="Button (a link drawn as a button)" onClick={() => run((v, s0, e0) => insertBlock(v, e0, `[button: ${v.slice(s0, e0) || "Read the story"}](https://)`))}>
            <RectangleHorizontal className="size-4" />
          </Btn>
          <Btn title="Image spot — click it in the email to upload or pick a frame" onClick={() => run((v, _s0, e0) => insertBlock(v, e0, `*[Screenshot: Image ${(v.match(/\[Screenshot/g)?.length ?? 0) + 1}]*`))}>
            <Camera className="size-4" />
          </Btn>
          <Btn title="Divider" onClick={() => run((v, _s0, e0) => insertBlock(v, e0, "---"))}>
            <Minus className="size-4" />
          </Btn>
          <Sep />
          <Btn title="First name (HubSpot fills it in; 'there' when unknown)" onClick={() => run((v, _s0, e0) => ({ value: `${v.slice(0, e0)}{{first_name}}${v.slice(e0)}`, start: e0 + 14, end: e0 + 14 }))}>
            <AtSign className="size-4" />
          </Btn>
        </>
      )}
    </div>
  );
}

/** A draft section open for typing: images as tokens, and the formatting toolbar (marks, links, lists, button, image spot, first name). */
function DraftTextBox({ markdown, onChange, onDone }: { markdown: string; onChange: (md: string) => void; onDone: () => void }) {
  // One token map per editing session (the box remounts each time it opens).
  const [tokens] = useState(() => new Map<string, string>());
  const text = collapseImages(markdown, tokens);
  const { ref, apply, edit } = useInlineFormat();
  const format = (mark: InlineMark) => {
    const next = apply(text, mark);
    if (next != null) onChange(expandImages(next, tokens));
  };
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <Toolbar text={text} onChange={(next) => onChange(expandImages(next, tokens))} edit={edit} />
      <textarea
        ref={ref}
        autoFocus
        value={text}
        onChange={(e) => onChange(expandImages(e.target.value, tokens))}
        onKeyDown={(e) => {
          const mark = formatShortcut(e);
          if (!mark) return;
          e.preventDefault();
          format(mark);
        }}
        // The link field in the toolbar takes focus for a moment; only a real click-away finishes.
        onBlur={(e) => {
          const to = e.relatedTarget as HTMLElement | null;
          if (to && e.currentTarget.parentElement?.contains(to)) return;
          onDone();
        }}
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
