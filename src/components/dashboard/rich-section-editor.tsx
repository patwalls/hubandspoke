"use client";

// The newsletter editor's text editing: a real WYSIWYG editor (TipTap) in
// place of the section, styled like the email around it — bold is bold, links
// are links, buttons are buttons, screenshots are the picked frames. No
// Markdown is ever shown. The section is still stored as our constrained
// Markdown (newsletter-rich-doc.ts converts both ways), which the drafter,
// the email renderer and both pushes read.
//
// Custom nodes: `screenshot` (a spot: the picked frame or a dashed box; click
// it to pick / upload), `ctaButton` (a button with its text and link, edited
// in place), `firstName` (the personalization token, shown as a chip), and
// images (click to swap / remove in the side panel).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, useEditor, mergeAttributes, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { ArrowDown, ArrowUp, AtSign, Bold, Camera, Copy, GripVertical, Heading2, Italic, Link2, List, ListOrdered, Minus, Plus, Quote, RectangleHorizontal, Trash2, Type, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { docToMarkdown, markdownToDoc, type DocNode } from "@/lib/newsletter-rich-doc";

export interface RichEditorHooks {
  /** The picked image for a screenshot spot, by its label (null: not picked yet). */
  shotUrl?: (label: string) => string | null;
  /** A screenshot spot / an image was clicked: open its panel (the editor finishes first). */
  onOpenShot?: (label: string) => void;
  onOpenImage?: (index: number) => void;
}

// ── Custom nodes ────────────────────────────────────────────────────────

function ShotView({ node, extension }: NodeViewProps) {
  const hooks = extension.options as RichEditorHooks;
  const label = String(node.attrs.label ?? "");
  const url = hooks.shotUrl?.(label) ?? null;
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <button
        type="button"
        contentEditable={false}
        onClick={() => hooks.onOpenShot?.(label)}
        title="Click to pick a frame or upload an image"
        className="group relative block w-full cursor-pointer rounded-[12px] outline-offset-2 hover:outline-2 hover:outline-solid hover:outline-[#49adff]/60"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} style={{ display: "block", width: "100%", borderRadius: 10 }} />
        ) : (
          <span className="flex w-full flex-col items-center justify-center gap-0.5 rounded-[10px] border-2 border-dashed border-[#c7d2dc] bg-[#f7fafc] px-6 py-6 text-center text-[13px] leading-normal text-[#6b7280]">
            <span className="flex items-center gap-1.5 font-semibold">
              <Camera className="size-3.5" /> Screenshot{node.attrs.sec ? ` @ ${String(node.attrs.sec)}` : ""}
            </span>
            <span>{label}</span>
            <span className="mt-1 text-[12px] text-[#49adff]">Click to pick a frame or upload</span>
          </span>
        )}
      </button>
    </NodeViewWrapper>
  );
}

const Screenshot = Node.create<RichEditorHooks>({
  name: "screenshot",
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({}),
  addAttributes: () => ({ label: { default: "Image" }, sec: { default: null } }),
  parseHTML: () => [{ tag: "div[data-shot]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-shot": "" })],
  addNodeView() {
    return ReactNodeViewRenderer(ShotView);
  },
});

function ButtonView({ node, updateAttributes, selected }: NodeViewProps) {
  const [editing, setEditing] = useState(!node.attrs.href || node.attrs.href === "https://");
  const [text, setText] = useState(String(node.attrs.text ?? ""));
  const [href, setHref] = useState(String(node.attrs.href ?? ""));
  return (
    <NodeViewWrapper className="my-2 flex flex-col items-center gap-1.5" data-drag-handle>
      <span
        contentEditable={false}
        onClick={() => setEditing(true)}
        className={cn("inline-block cursor-pointer rounded-lg px-[26px] py-[13px] font-bold leading-tight text-white", selected && "outline-2 outline-offset-2 outline-[#49adff] outline-solid")}
        style={{ background: "var(--nl-button, #197bbd)" }}
        title="Click to edit the button"
      >
        {String(node.attrs.text || "Button")}
      </span>
      {editing && (
        <span contentEditable={false} className="flex w-full max-w-md flex-wrap items-center justify-center gap-1.5 rounded-md border bg-white p-1.5 text-[12px] shadow-sm">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Button text"
            className="h-7 w-36 rounded border px-1.5 outline-none focus:border-[#49adff]"
            onKeyDown={(e) => e.key === "Enter" && (updateAttributes({ text, href }), setEditing(false))}
          />
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="https://…"
            className="h-7 min-w-0 flex-1 rounded border px-1.5 outline-none focus:border-[#49adff]"
            onKeyDown={(e) => e.key === "Enter" && (updateAttributes({ text, href }), setEditing(false))}
          />
          <button
            type="button"
            onClick={() => {
              updateAttributes({ text, href });
              setEditing(false);
            }}
            className="rounded bg-[#49adff] px-2 py-1 font-medium text-white"
          >
            Done
          </button>
        </span>
      )}
    </NodeViewWrapper>
  );
}

const CtaButton = Node.create({
  name: "ctaButton",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ text: { default: "Read the story" }, href: { default: "https://" } }),
  parseHTML: () => [{ tag: "div[data-cta]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-cta": "" })],
  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },
});

function FirstNameView() {
  return (
    <NodeViewWrapper as="span" className="mx-px inline-flex items-center rounded bg-[#eef6ff] px-1 align-baseline text-[0.9em] font-medium text-[#2563eb]" title="The reader's first name ('there' when unknown)">
      First name
    </NodeViewWrapper>
  );
}

const FirstName = Node.create({
  name: "firstName",
  group: "inline",
  inline: true,
  atom: true,
  parseHTML: () => [{ tag: "span[data-first-name]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-first-name": "" }), "{{first_name}}"],
  addNodeView() {
    return ReactNodeViewRenderer(FirstNameView);
  },
});

function ImageView({ node, extension, getPos, editor }: NodeViewProps) {
  const hooks = extension.options as RichEditorHooks & Record<string, unknown>;
  const open = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    let index = 0;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "image" && pos != null && p < pos) index++;
    });
    hooks.onOpenImage?.(index);
  };
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <button type="button" contentEditable={false} onClick={open} title="Click to change or remove this image" className="block w-full cursor-pointer rounded-[12px] outline-offset-2 hover:outline-2 hover:outline-solid hover:outline-[#49adff]/60">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={String(node.attrs.src ?? "")} alt={String(node.attrs.alt ?? "")} style={{ display: "block", width: "100%", borderRadius: 10 }} />
      </button>
    </NodeViewWrapper>
  );
}

// ── Toolbar ─────────────────────────────────────────────────────────────

function Btn({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      // Keep the editor focused (a blur would finish editing).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("flex size-7 items-center justify-center rounded text-[#222] hover:bg-[#eef6ff]", active && "bg-[#e0efff] text-[#1d4ed8]")}
    >
      {children}
    </button>
  );
}
const Sep = () => <span className="mx-0.5 h-4 w-px bg-[#e5e7eb]" />;

function Toolbar({ editor, className }: { editor: Editor; className?: string }) {
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  // Re-render on selection / formatting changes so the active states follow the cursor.
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    editor.on("selectionUpdate", on);
    editor.on("transaction", on);
    return () => {
      editor.off("selectionUpdate", on);
      editor.off("transaction", on);
    };
  }, [editor]);
  const chain = () => editor.chain().focus();
  if (linkUrl !== null) {
    return (
      <form
        className={cn("flex items-center gap-1 rounded-md border bg-white p-1 shadow-md", className)}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const url = linkUrl.trim();
          if (url) chain().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
          setLinkUrl(null);
        }}
      >
        <Link2 className="ml-1 size-3.5 text-[#6b7280]" />
        <input
          autoFocus
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setLinkUrl(null), editor.commands.focus())}
          placeholder="Paste a link"
          className="h-7 w-64 rounded border px-1.5 text-[12px] outline-none focus:border-[#49adff]"
        />
        <button type="submit" className="rounded bg-[#49adff] px-2.5 py-1 text-[12px] font-medium text-white">
          Apply
        </button>
      </form>
    );
  }
  return (
    <div className={cn("flex items-center gap-0.5 rounded-md border bg-white p-0.5 shadow-md", className)}>
      <Btn title="Bold (⌘B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}>
        <Bold className="size-4" />
      </Btn>
      <Btn title="Italic (⌘I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}>
        <Italic className="size-4" />
      </Btn>
      {editor.isActive("link") ? (
        <Btn title="Remove the link" active onClick={() => chain().extendMarkRange("link").unsetLink().run()}>
          <Unlink className="size-4" />
        </Btn>
      ) : (
        <Btn title="Link (⌘K)" onClick={() => setLinkUrl(String(editor.getAttributes("link").href ?? ""))}>
          <Link2 className="size-4" />
        </Btn>
      )}
      <Sep />
      <Btn title="Heading" active={editor.isActive("heading")} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="size-4" />
      </Btn>
      <Btn title="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>
        <List className="size-4" />
      </Btn>
      <Btn title="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className="size-4" />
      </Btn>
      <Btn title="Quote" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}>
        <Quote className="size-4" />
      </Btn>
      <Sep />
      <Btn title="Button" onClick={() => chain().insertContent({ type: "ctaButton", attrs: { text: editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) || "Read the story", href: "https://" } }).run()}>
        <RectangleHorizontal className="size-4" />
      </Btn>
      <Btn
        title="Image — click it in the email to upload or pick a frame"
        onClick={() => {
          let n = 1;
          editor.state.doc.descendants((node) => {
            if (node.type.name === "screenshot") n++;
          });
          chain().insertContent({ type: "screenshot", attrs: { label: `Image ${n}`, sec: null } }).run();
        }}
      >
        <Camera className="size-4" />
      </Btn>
      <Btn title="Divider" onClick={() => chain().setHorizontalRule().run()}>
        <Minus className="size-4" />
      </Btn>
      <Sep />
      <Btn title="The reader's first name ('there' when unknown)" onClick={() => chain().insertContent({ type: "firstName" }).run()}>
        <AtSign className="size-4" />
      </Btn>
    </div>
  );
}

// ── Block handle ────────────────────────────────────────────────────────
// Hover any block (paragraph, list, image, button…) and a handle appears in
// the left gutter: + adds a block below it (text, photo, button, divider),
// ⋮ duplicates, moves or deletes it. Works on top-level blocks.

type BlockInsert = "text" | "photo" | "button" | "divider";

/** The top-level block at `index`: its position and size. */
function blockAt(editor: Editor, index: number): { pos: number; size: number } | null {
  const doc = editor.state.doc;
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return { pos, size: doc.child(index).nodeSize };
}

function newBlock(editor: Editor, kind: BlockInsert): Record<string, unknown> {
  if (kind === "text") return { type: "paragraph" };
  if (kind === "divider") return { type: "horizontalRule" };
  if (kind === "button") return { type: "ctaButton", attrs: { text: "Read the story", href: "https://" } };
  let n = 1;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "screenshot") n++;
  });
  return { type: "screenshot", attrs: { label: `Image ${n}`, sec: null } };
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-[#f3f4f6]", danger ? "text-[#b91c1c]" : "text-[#222]")}>
      {icon}
      {label}
    </button>
  );
}

function BlockHandle({ editor, container }: { editor: Editor; container: HTMLDivElement | null }) {
  const [hover, setHover] = useState<{ index: number; top: number } | null>(null);
  const [menu, setMenu] = useState<"add" | "more" | null>(null);
  useEffect(() => {
    if (!container) return;
    const onMove = (e: MouseEvent) => {
      if (menu) return;
      const root = editor.view.dom as HTMLElement;
      // The top-level block under the pointer's height (the gutter counts too).
      const kids = Array.from(root.children) as HTMLElement[];
      const idx = kids.findIndex((k) => {
        const b = k.getBoundingClientRect();
        return e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6;
      });
      if (idx < 0) return;
      const box = kids[idx].getBoundingClientRect();
      const host = container.getBoundingClientRect();
      setHover({ index: idx, top: box.top - host.top + Math.min(box.height / 2, 14) - 12 });
    };
    const onLeave = () => !menu && setHover(null);
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
    };
  }, [container, editor, menu]);
  if (!hover) return null;
  const at = blockAt(editor, hover.index);
  if (!at) return null;
  const done = () => {
    setMenu(null);
    setHover(null);
  };
  const insert = (kind: BlockInsert) => {
    const pos = at.pos + at.size;
    const chain = editor.chain().insertContentAt(pos, newBlock(editor, kind));
    if (kind === "text") chain.setTextSelection(pos + 1);
    chain.focus().run();
    done();
  };
  const duplicate = () => {
    const node = editor.state.doc.child(hover.index);
    editor.chain().insertContentAt(at.pos + at.size, node.toJSON()).focus().run();
    done();
  };
  const move = (dir: -1 | 1) => {
    const doc = editor.state.doc;
    const j = hover.index + dir;
    if (j < 0 || j >= doc.childCount) return done();
    const node = doc.child(hover.index);
    const tr = editor.state.tr.delete(at.pos, at.pos + at.size);
    const other = blockAt(editor, j)!;
    const target = dir < 0 ? other.pos : other.pos + other.size - at.size;
    tr.insert(target, node);
    editor.view.dispatch(tr);
    editor.commands.focus();
    done();
  };
  const remove = () => {
    if (editor.state.doc.childCount === 1) editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    else editor.chain().deleteRange({ from: at.pos, to: at.pos + at.size }).focus().run();
    done();
  };
  return (
    <div className="absolute z-30 flex items-start gap-0.5" style={{ top: hover.top, left: -60 }} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" title="Add a block below" onClick={() => setMenu(menu === "add" ? null : "add")} className="flex size-6 items-center justify-center rounded text-[#9ca3af] hover:bg-[#eef6ff] hover:text-[#2563eb]">
        <Plus className="size-4" />
      </button>
      <button type="button" title="Duplicate, move or delete" onClick={() => setMenu(menu === "more" ? null : "more")} className="flex size-6 cursor-grab items-center justify-center rounded text-[#9ca3af] hover:bg-[#eef6ff] hover:text-[#2563eb]">
        <GripVertical className="size-4" />
      </button>
      {menu && (
        <div className="absolute left-0 top-7 w-44 rounded-md border bg-white p-1 shadow-lg" onMouseLeave={() => setMenu(null)}>
          {menu === "add" ? (
            <>
              <MenuItem icon={<Type className="size-3.5" />} label="Text" onClick={() => insert("text")} />
              <MenuItem icon={<Camera className="size-3.5" />} label="Photo" onClick={() => insert("photo")} />
              <MenuItem icon={<RectangleHorizontal className="size-3.5" />} label="Button" onClick={() => insert("button")} />
              <MenuItem icon={<Minus className="size-3.5" />} label="Divider" onClick={() => insert("divider")} />
            </>
          ) : (
            <>
              <MenuItem icon={<Copy className="size-3.5" />} label="Duplicate" onClick={duplicate} />
              <MenuItem icon={<ArrowUp className="size-3.5" />} label="Move up" onClick={() => move(-1)} />
              <MenuItem icon={<ArrowDown className="size-3.5" />} label="Move down" onClick={() => move(1)} />
              <MenuItem icon={<Trash2 className="size-3.5" />} label="Delete" onClick={remove} danger />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────

/** The look inside the editor: `.nl-rich` in globals.css (the email's own type scale). */
const PROSE = "nl-rich outline-none";

export function RichSectionEditor({
  markdown,
  onChange,
  onDone,
  hooks,
  standalone = false,
  placeholder = "Write here…",
  autoFocus = true,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
  /** Click-away / Escape finishes (in place on the canvas). */
  onDone?: () => void;
  hooks?: RichEditorHooks;
  /** A box of its own (the side panel): border + a toolbar always on top, no floating. */
  standalone?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const hooksRef = useRef(hooks);
  useLayoutEffect(() => {
    hooksRef.current = hooks;
  });
  // Hooks are read through the ref so the editor (built once) always calls the latest ones.
  const [live] = useState<RichEditorHooks>(() => ({
    shotUrl: (l) => hooksRef.current?.shotUrl?.(l) ?? null,
    onOpenShot: (l) => hooksRef.current?.onOpenShot?.(l),
    onOpenImage: (i) => hooksRef.current?.onOpenImage?.(i),
  }));
  const lastEmitted = useRef(markdown);
  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false, strike: false, underline: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noreferrer", target: "_blank" } } }),
      Image.extend({ addOptions() {
        return { ...this.parent?.(), ...live };
      }, addNodeView() {
        return ReactNodeViewRenderer(ImageView);
      } }),
      Screenshot.configure(live),
      CtaButton,
      FirstName,
      Placeholder.configure({ placeholder }),
    ],
    content: markdownToDoc(markdown) as unknown as Record<string, unknown>,
    editorProps: { attributes: { class: PROSE } },
    onUpdate: ({ editor: e }) => {
      const md = docToMarkdown(e.getJSON() as DocNode);
      lastEmitted.current = md;
      onChange(md);
    },
  });

  // A change from outside (Regenerate landed, a proofread fix) replaces the content.
  useEffect(() => {
    if (!editor || markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    editor.commands.setContent(markdownToDoc(markdown) as unknown as Record<string, unknown>, { emitUpdate: false });
  }, [editor, markdown]);

  if (!editor) return <div className="min-h-16" />;
  return (
    <div
      ref={wrapper}
      className={cn("relative", standalone ? "rounded-md border bg-background" : "-mx-2 rounded-md px-2 py-1.5 outline-2 outline-[#49adff] outline-solid")}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onDone) {
          e.preventDefault();
          onDone();
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") e.preventDefault();
      }}
      onBlur={(e) => {
        // Moving into the toolbar's link field or a button's fields isn't leaving.
        const to = e.relatedTarget as HTMLElement | null;
        if (to && wrapper.current?.contains(to)) return;
        onDone?.();
      }}
    >
      <Toolbar editor={editor} className={standalone ? "rounded-b-none border-0 border-b shadow-none" : "sticky top-2 z-20 -mt-11 mb-2 ml-auto w-fit"} />
      <div ref={setBody} className={cn("relative", standalone ? "px-3 py-2 text-sm" : undefined)}>
        {!standalone && <BlockHandle editor={editor} container={body} />}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
