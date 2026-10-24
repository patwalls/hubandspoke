"use client";

// The newsletter template's design, edited WYSIWYG — the same editor and the
// same look as a draft (rich-section-editor.tsx), on the template's layout
// document (newsletter-layout.ts). What you see is the email: the masthead
// image, headings (click the pill button for a colored pill), tinted boxes,
// dividers, fixed text, buttons — and the AI SECTIONS, one block each, where
// every issue's drafted text goes. Click an AI section to edit what the
// drafter writes there (the side panel); its look is whatever is designed
// around it. Hover any block for + (add Text / Photo / Button / Divider / AI
// section below) and ⋮ (duplicate, move, delete).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import { Bold, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Palette, RectangleHorizontal, Sparkles, SquareDashed, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockHandle, Btn, CtaButton, FirstName, Sep } from "@/components/dashboard/rich-section-editor";
import type { LayoutDoc } from "@/lib/newsletter-layout";
import type { NewsletterTemplateSection } from "@/lib/newsletter-template";

/** Pill and box colors to pick from (the house palette; any hex works too). */
const SWATCHES = ["#fed7aa", "#fae8ff", "#fef9c3", "#dcfce7", "#e0f2fe", "#EBECFC", "#f1f5f9", "#fee2e2"];

interface LayoutHooks {
  section: (key: string) => NewsletterTemplateSection | null;
  selected: () => string | null;
  onSelect: (key: string) => void;
}

// ── Nodes ───────────────────────────────────────────────────────────────

/** A heading that can be a colored pill (Sunday Breakfast's course names). */
const PillHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      pill: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-pill"),
        renderHTML: (attrs: { pill?: string | null }) =>
          attrs.pill ? { "data-pill": attrs.pill, style: `background:${attrs.pill};display:inline-block;padding:8px 14px;border-radius:8px;font-size:19px;line-height:1.2;margin:0 0 14px` } : {},
      },
    };
  },
});

/** A tinted box around blocks (the sponsor's). */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    color: {
      default: "#f1f5f9",
      parseHTML: (el: HTMLElement) => el.getAttribute("data-color"),
      renderHTML: (attrs: { color?: string }) => ({ "data-color": attrs.color, style: `background:${attrs.color};border-radius:12px;padding:20px 22px 6px;margin:0 0 16px` }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0],
});

function SlotView({ node, extension, selected }: NodeViewProps) {
  const hooks = extension.options as LayoutHooks;
  const key = String(node.attrs.key ?? "");
  const sec = hooks.section(key);
  const active = selected || hooks.selected() === key;
  const sponsor = sec?.kind === "sponsor";
  return (
    <NodeViewWrapper className="my-2" data-drag-handle>
      <div
        contentEditable={false}
        onClick={() => hooks.onSelect(key)}
        title="Click to edit what AI writes here"
        className={cn(
          "cursor-pointer rounded-lg border border-dashed px-3 py-2.5 transition-colors",
          active ? "border-[#49adff] bg-[#eef6ff]" : "border-[#c7d2dc] bg-[#f8fafc] hover:border-[#49adff]",
        )}
      >
        <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#2563eb]">
          <Sparkles className="size-3" />
          {sponsor ? "Sponsor (from Asana)" : "AI section"}
          <span className="font-normal normal-case tracking-normal text-[#6b7280]">· {sec?.heading || key.replace(/_/g, " ")}</span>
          {sec?.optional && <span className="rounded bg-white px-1 font-normal normal-case tracking-normal text-[#6b7280]">optional</span>}
        </span>
        <span className="line-clamp-3 block text-[14px] italic leading-snug text-[#6b7280]">{sec?.hint?.trim() || "Click to write what AI puts here each issue."}</span>
      </div>
    </NodeViewWrapper>
  );
}

const Slot = Node.create<LayoutHooks>({
  name: "slot",
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({ section: () => null, selected: () => null, onSelect: () => undefined }),
  addAttributes: () => ({ key: { default: "" } }),
  parseHTML: () => [{ tag: "div[data-slot]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-slot": "" })],
  addNodeView() {
    return ReactNodeViewRenderer(SlotView);
  },
});

function DesignImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const [open, setOpen] = useState(!node.attrs.src);
  const [src, setSrc] = useState(String(node.attrs.src ?? ""));
  const [href, setHref] = useState(String(node.attrs.href ?? ""));
  const bg = typeof node.attrs.background === "string" ? node.attrs.background : null;
  const save = () => {
    updateAttributes({ src: src.trim(), href: href.trim() || null });
    setOpen(false);
  };
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <div contentEditable={false} onClick={() => setOpen(true)} className={cn("cursor-pointer overflow-hidden rounded-[12px]", selected && "outline-2 outline-offset-2 outline-[#49adff] outline-solid")} style={{ background: bg ?? "transparent" }}>
        {node.attrs.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={String(node.attrs.src)} alt={String(node.attrs.alt ?? "")} style={{ display: "block", width: "100%", borderRadius: 12 }} />
        ) : (
          <span className="flex h-28 items-center justify-center gap-1.5 rounded-[12px] border-2 border-dashed border-[#c7d2dc] text-[13px] text-[#6b7280]">
            <ImagePlus className="size-4" /> Paste an image link
          </span>
        )}
      </div>
      {open && (
        <div contentEditable={false} className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border bg-white p-1.5 text-[12px] shadow-sm">
          <input autoFocus value={src} onChange={(e) => setSrc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Image URL" className="h-7 min-w-0 flex-1 rounded border px-1.5 outline-none focus:border-[#49adff]" />
          <input value={href} onChange={(e) => setHref(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Links to (optional)" className="h-7 w-44 rounded border px-1.5 outline-none focus:border-[#49adff]" />
          <label className="flex items-center gap-1 text-[#6b7280]" title="Background behind the image">
            <input type="color" value={bg ?? "#ffffff"} onChange={(e) => updateAttributes({ background: e.target.value })} className="h-6 w-7 cursor-pointer rounded border" />
            {bg && (
              <button type="button" onClick={() => updateAttributes({ background: null })} className="underline">
                none
              </button>
            )}
          </label>
          <button type="button" onClick={save} className="rounded bg-[#49adff] px-2 py-1 font-medium text-white">
            Done
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

const DesignImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), href: { default: null }, background: { default: null } };
  },
  addNodeView() {
    return ReactNodeViewRenderer(DesignImageView);
  },
});

// ── Toolbar ─────────────────────────────────────────────────────────────

function Swatches({ value, onPick, onNone }: { value: string | null; onPick: (c: string) => void; onNone: () => void }) {
  return (
    <div className="absolute right-0 top-9 z-30 flex w-56 flex-wrap items-center gap-1.5 rounded-md border bg-white p-2 shadow-lg" onMouseDown={(e) => e.preventDefault()}>
      {SWATCHES.map((c) => (
        <button key={c} type="button" title={c} onClick={() => onPick(c)} className={cn("size-6 rounded-full border", value?.toLowerCase() === c.toLowerCase() && "ring-2 ring-[#49adff] ring-offset-1")} style={{ background: c }} />
      ))}
      <label className="flex size-6 cursor-pointer items-center justify-center rounded-full border text-[10px] text-[#6b7280]" title="Any color">
        +
        <input type="color" className="sr-only" value={value ?? "#ffffff"} onChange={(e) => onPick(e.target.value)} />
      </label>
      <button type="button" onClick={onNone} className="ml-auto text-[11px] text-[#6b7280] underline">
        None
      </button>
    </div>
  );
}

function LayoutToolbar({ editor, onAddSlot }: { editor: Editor; onAddSlot: () => string }) {
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [colors, setColors] = useState<"pill" | "box" | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
    };
  }, [editor]);
  const chain = () => editor.chain().focus();
  const inHeading = editor.isActive("heading");
  const inBox = editor.isActive("callout");
  if (linkUrl !== null) {
    return (
      <form
        className="flex items-center gap-1 rounded-md border bg-white p-1 shadow-md"
        onSubmit={(e) => {
          e.preventDefault();
          const url = linkUrl.trim();
          if (url) chain().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
          setLinkUrl(null);
        }}
      >
        <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setLinkUrl(null)} placeholder="Paste a link" className="h-7 w-64 rounded border px-1.5 text-[12px] outline-none focus:border-[#49adff]" />
        <button type="submit" className="rounded bg-[#49adff] px-2.5 py-1 text-[12px] font-medium text-white">
          Apply
        </button>
      </form>
    );
  }
  return (
    <div className="relative flex flex-wrap items-center gap-0.5 rounded-md border bg-white p-0.5 shadow-md">
      <Btn title="Bold" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}>
        <Bold className="size-4" />
      </Btn>
      <Btn title="Italic" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}>
        <Italic className="size-4" />
      </Btn>
      {editor.isActive("link") ? (
        <Btn title="Remove the link" active onClick={() => chain().extendMarkRange("link").unsetLink().run()}>
          <Unlink className="size-4" />
        </Btn>
      ) : (
        <Btn title="Link" onClick={() => setLinkUrl(String(editor.getAttributes("link").href ?? ""))}>
          <Link2 className="size-4" />
        </Btn>
      )}
      <Sep />
      <Btn title="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="size-4" />
      </Btn>
      <Btn title="Small heading" active={editor.isActive("heading", { level: 3 })} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="size-4" />
      </Btn>
      <Btn title={inHeading ? "Pill color for this heading" : "Click into a heading to make it a colored pill"} active={!!editor.getAttributes("heading").pill} onClick={() => inHeading && setColors(colors === "pill" ? null : "pill")}>
        <Palette className={cn("size-4", !inHeading && "opacity-40")} />
      </Btn>
      <Btn title="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>
        <List className="size-4" />
      </Btn>
      <Btn title="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className="size-4" />
      </Btn>
      <Btn title={inBox ? "Box color / remove the box" : "Put this in a tinted box"} active={inBox} onClick={() => (inBox ? setColors(colors === "box" ? null : "box") : chain().wrapIn("callout", { color: "#f1f5f9" }).run())}>
        <SquareDashed className="size-4" />
      </Btn>
      <Sep />
      <Btn title="Image" onClick={() => chain().insertContent({ type: "image", attrs: { src: "", alt: "" } }).run()}>
        <ImagePlus className="size-4" />
      </Btn>
      <Btn title="Button" onClick={() => chain().insertContent({ type: "ctaButton", attrs: { text: "Read the story", href: "https://" } }).run()}>
        <RectangleHorizontal className="size-4" />
      </Btn>
      <Btn title="Divider" onClick={() => chain().setHorizontalRule().run()}>
        <Minus className="size-4" />
      </Btn>
      <Sep />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => chain().insertContent({ type: "slot", attrs: { key: onAddSlot() } }).run()}
        className="flex h-7 items-center gap-1 rounded px-2 text-[12px] font-medium text-[#2563eb] hover:bg-[#eef6ff]"
        title="A section AI writes every issue"
      >
        <Sparkles className="size-3.5" /> AI section
      </button>
      {colors === "pill" && (
        <Swatches
          value={(editor.getAttributes("heading").pill as string | null) ?? null}
          onPick={(c) => (chain().updateAttributes("heading", { pill: c }).run(), setColors(null))}
          onNone={() => (chain().updateAttributes("heading", { pill: null }).run(), setColors(null))}
        />
      )}
      {colors === "box" && (
        <Swatches
          value={(editor.getAttributes("callout").color as string | null) ?? null}
          onPick={(c) => (chain().updateAttributes("callout", { color: c }).run(), setColors(null))}
          onNone={() => (chain().lift("callout").run(), setColors(null))}
        />
      )}
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────

export function LayoutEditor({
  layout,
  sections,
  selected,
  onChange,
  onSelectSlot,
  onAddSlot,
  editorRef,
}: {
  layout: LayoutDoc;
  sections: NewsletterTemplateSection[];
  selected: string | null;
  onChange: (layout: LayoutDoc) => void;
  onSelectSlot: (key: string) => void;
  /** A new section for a slot being inserted: returns its key. */
  onAddSlot: () => string;
  /** The editor, for the side panel (remove a slot). */
  editorRef?: React.MutableRefObject<Editor | null>;
}) {
  const live = useRef({ sections, selected, onSelectSlot });
  useLayoutEffect(() => {
    live.current = { sections, selected, onSelectSlot };
  });
  const [hooks] = useState<LayoutHooks>(() => ({
    section: (key) => live.current.sections.find((s) => s.key === key) ?? null,
    selected: () => live.current.selected,
    onSelect: (key) => live.current.onSelectSlot(key),
  }));
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, code: false, codeBlock: false, strike: false, underline: false, link: { openOnClick: false, autolink: true } }),
      PillHeading.configure({ levels: [2, 3] }),
      Callout,
      DesignImage,
      Slot.configure(hooks),
      CtaButton,
      FirstName,
    ],
    content: layout as unknown as Record<string, unknown>,
    editorProps: { attributes: { class: "nl-rich outline-none" } },
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as LayoutDoc),
  });
  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);
  // Slot cards show the latest instructions / selection.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta("slot-refresh", true));
  }, [editor, sections, selected]);

  if (!editor) return <div className="min-h-40" />;
  return (
    <div className="relative">
      <div className="sticky top-2 z-20 mb-3 flex justify-center">
        <LayoutToolbar editor={editor} onAddSlot={onAddSlot} />
      </div>
      <div ref={setBody} className="relative">
        <BlockHandle
          editor={editor}
          container={body}
          extraInserts={[{ label: "AI section", icon: <Sparkles className="size-3.5 text-[#2563eb]" />, make: () => ({ type: "slot", attrs: { key: onAddSlot() } }) }]}
        />
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/** Remove a slot node (by key) from the layout. */
export function removeSlot(editor: Editor, key: string) {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((n, pos) => {
    if (!found && n.type.name === "slot" && n.attrs.key === key) found = { from: pos, to: pos + n.nodeSize };
  });
  if (found) editor.chain().deleteRange(found).run();
}
