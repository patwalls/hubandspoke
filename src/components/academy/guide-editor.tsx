"use client";

// The step-by-step guide under an Academy video: a WYSIWYG editor (TipTap),
// so editors never see HTML or Markdown. Produces the small HTML vocabulary
// sanitized by src/lib/academy/guide-html.ts:
//   step headings (h2/h3), text, lists, links, screenshots with captions
//   (`figure`), tip boxes (`callout`), extra videos (`videoEmbed`).
// Screenshots upload through POST /api/academy/images — pick, paste or drop.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { toast } from "sonner";
import { Bold, Heading2, Heading3, ImagePlus, Italic, Lightbulb, Link2, List, ListOrdered, Minus, PlayCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { videoEmbedUrl } from "@/lib/academy/video-embed";
import { GUIDE_PROSE } from "@/components/academy/guide-prose";

// ── Upload ──────────────────────────────────────────────────────────────

async function uploadImage(file: File): Promise<string> {
  const res = await fetch("/api/academy/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name || "screenshot.png", contentType: file.type, fileSize: file.size }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Couldn't upload the image");
  const put = await fetch(data.uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return data.fileUrl as string;
}

const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));

// ── Custom nodes ────────────────────────────────────────────────────────

function FigureView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  return (
    <NodeViewWrapper className={cn("my-4 rounded-lg", selected && "ring-2 ring-orange-400 ring-offset-2")} data-drag-handle>
      <div className="group relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={String(node.attrs.src)} alt={String(node.attrs.caption ?? "")} className="block w-full rounded-lg border border-border" />
        <button
          type="button"
          onClick={deleteNode}
          className="absolute right-2 top-2 hidden rounded-md bg-background/90 p-1 text-muted-foreground shadow ring-1 ring-border hover:text-destructive group-hover:block"
          aria-label="Remove image"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <input
        value={String(node.attrs.caption ?? "")}
        onChange={(e) => updateAttributes({ caption: e.target.value })}
        placeholder="Add a caption (optional)"
        className="mt-1.5 w-full bg-transparent text-center text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
      />
    </NodeViewWrapper>
  );
}

const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, caption: { default: "" } }),
  parseHTML: () => [
    {
      tag: "figure[data-figure]",
      getAttrs: (el) => {
        const e = el as HTMLElement;
        return { src: e.querySelector("img")?.getAttribute("src") ?? null, caption: e.querySelector("figcaption")?.textContent ?? "" };
      },
    },
  ],
  renderHTML: ({ node }) => {
    const img: DOMOutputSpec = ["img", { src: node.attrs.src }];
    return node.attrs.caption
      ? ["figure", { "data-figure": "" }, img, ["figcaption", {}, String(node.attrs.caption)]]
      : ["figure", { "data-figure": "" }, img];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },
});

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout": "tip" }), 0],
});

function VideoEmbedView({ node, deleteNode, selected }: NodeViewProps) {
  const src = videoEmbedUrl(String(node.attrs.url ?? ""));
  return (
    <NodeViewWrapper className={cn("group relative my-4 rounded-lg", selected && "ring-2 ring-orange-400 ring-offset-2")} data-drag-handle>
      {src ? (
        <div className="pointer-events-none relative aspect-video overflow-hidden rounded-lg bg-black">
          <iframe src={src} title="Video" className="absolute inset-0 size-full border-0" />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">Unsupported video link</div>
      )}
      <button
        type="button"
        onClick={deleteNode}
        className="absolute right-2 top-2 hidden rounded-md bg-background/90 p-1 text-muted-foreground shadow ring-1 ring-border hover:text-destructive group-hover:block"
        aria-label="Remove video"
      >
        <Trash2 className="size-3.5" />
      </button>
    </NodeViewWrapper>
  );
}

const VideoEmbed = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({
    url: {
      default: null,
      parseHTML: (el) => el.getAttribute("data-video-embed"),
      renderHTML: (attrs) => ({ "data-video-embed": attrs.url }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-video-embed]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", HTMLAttributes],
  addNodeView() {
    return ReactNodeViewRenderer(VideoEmbedView);
  },
});

// ── Editor ──────────────────────────────────────────────────────────────

export function GuideEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [uploading, setUploading] = useState(0);

  async function insertImages(files: File[]) {
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const src = await uploadImage(file);
        editorRef.current?.chain().focus().insertContent({ type: "figure", attrs: { src, caption: "" } }).run();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't upload the image");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true },
      }),
      Placeholder.configure({ placeholder: "Write the steps — e.g. “Step 1: Connect your accounts”. Paste or drop screenshots right in." }),
      Figure,
      Callout,
      VideoEmbed,
    ],
    content: value || "",
    editorProps: {
      attributes: { class: cn(GUIDE_PROSE, "min-h-48 px-4 py-3 outline-none") },
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFiles((event as DragEvent).dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  if (!editor) return <div className="min-h-48 rounded-lg border border-input" />;

  const addLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (url.trim() === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const addVideo = () => {
    const url = window.prompt("Paste a Loom, YouTube, Vimeo or Google Drive link");
    if (!url) return;
    if (!videoEmbedUrl(url)) return toast.error("That link can't be embedded — use a Loom, YouTube, Vimeo or Drive link");
    editor.chain().focus().insertContent({ type: "videoEmbed", attrs: { url: url.trim() } }).run();
  };

  return (
    <div className="overflow-hidden rounded-lg border border-input focus-within:ring-2 focus-within:ring-ring">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 px-1.5 py-1">
        <Tool label="Step heading" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 />
        </Tool>
        <Tool label="Sub-heading" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 />
        </Tool>
        <Sep />
        <Tool label="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold />
        </Tool>
        <Tool label="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic />
        </Tool>
        <Tool label="Link" active={editor.isActive("link")} onClick={addLink}>
          <Link2 />
        </Tool>
        <Sep />
        <Tool label="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List />
        </Tool>
        <Tool label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered />
        </Tool>
        <Sep />
        <Tool label="Add screenshot" onClick={() => fileInput.current?.click()}>
          <ImagePlus />
        </Tool>
        <Tool label="Tip box" active={editor.isActive("callout")} onClick={() => editor.chain().focus().toggleWrap("callout").run()}>
          <Lightbulb />
        </Tool>
        <Tool label="Add a video" onClick={addVideo}>
          <PlayCircle />
        </Tool>
        <Tool label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus />
        </Tool>
        {uploading > 0 && <span className="ml-auto pr-1 text-xs text-muted-foreground">Uploading…</span>}
      </div>
      <EditorContent editor={editor} />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          void insertImages(imageFiles(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-border" />;
}
