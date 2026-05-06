"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, ReactRenderer, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import Image from "@tiptap/extension-image";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paperclip,
  Strikethrough,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionList, type MentionListRef, type MentionUser } from "./mention-list";

interface CommentEditorProps {
  value: string;
  onChange: (html: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

const EMPTY_HTML_RE = /^(\s|<p>\s*<\/p>|<br\s*\/?>)*$/i;

export function isEditorEmpty(html: string): boolean {
  return EMPTY_HTML_RE.test(html);
}

// Cached user list for @mention suggestions. Shared across editor instances on
// the same page so the composer + an open edit box don't double-fetch.
let mentionUsersCache: { at: number; users: MentionUser[] } | null = null;
const USERS_TTL_MS = 60_000;

async function fetchMentionUsers(): Promise<MentionUser[]> {
  const now = Date.now();
  if (mentionUsersCache && now - mentionUsersCache.at < USERS_TTL_MS) {
    return mentionUsersCache.users;
  }
  try {
    const res = await fetch("/api/users/assignable", { cache: "no-store" });
    if (!res.ok) return mentionUsersCache?.users ?? [];
    const data = (await res.json()) as { users: MentionUser[] };
    mentionUsersCache = { at: now, users: data.users };
    return data.users;
  } catch {
    return mentionUsersCache?.users ?? [];
  }
}

function filterUsers(users: MentionUser[], query: string): MentionUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return users.slice(0, 8);
  return users
    .filter((u) => {
      const name = (u.name || "").toLowerCase();
      const email = u.email.toLowerCase();
      return name.includes(q) || email.includes(q);
    })
    .slice(0, 8);
}

interface UploadResult {
  uploadUrl: string;
  fileUrl: string;
  key: string;
}

async function presignCommentAttachment(file: File): Promise<UploadResult> {
  const res = await fetch("/api/uploads/comment-attachment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Presign failed (${res.status})`);
  }
  return (await res.json()) as UploadResult;
}

async function uploadCommentAttachment(file: File): Promise<{
  fileUrl: string;
  isImage: boolean;
  name: string;
}> {
  const { uploadUrl, fileUrl } = await presignCommentAttachment(file);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return {
    fileUrl,
    isImage: file.type.startsWith("image/"),
    name: file.name,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function CommentEditor({
  value,
  onChange,
  onSubmit,
  placeholder = "Write a comment…",
  autoFocus = false,
  disabled = false,
}: CommentEditorProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const insertUploadedFile = useCallback(
    (editor: Editor, result: { fileUrl: string; isImage: boolean; name: string }) => {
      if (result.isImage) {
        editor
          .chain()
          .focus()
          .setImage({ src: result.fileUrl, alt: result.name })
          .run();
      } else {
        editor
          .chain()
          .focus()
          .insertContent(
            `<a href="${result.fileUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.name)}</a>`,
          )
          .run();
      }
    },
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          target: "_blank",
          rel: "noopener noreferrer",
          class: "text-blue-600 underline hover:text-blue-700 break-all",
        },
      }),
      Image.configure({
        HTMLAttributes: {
          class: "tiptap-image rounded border border-border max-w-full h-auto my-2",
        },
      }),
      Placeholder.configure({ placeholder }),
      Mention.configure({
        HTMLAttributes: { class: "mention", "data-type": "mention" },
        renderHTML: ({ options, node }) => [
          "span",
          {
            ...options.HTMLAttributes,
            "data-id": node.attrs.id,
            "data-label": node.attrs.label ?? node.attrs.id,
          },
          `@${node.attrs.label ?? node.attrs.id}`,
        ],
        suggestion: {
          char: "@",
          items: async ({ query }) => {
            const users = await fetchMentionUsers();
            return filterUsers(users, query);
          },
          render: () => {
            let component: ReactRenderer<MentionListRef> | null = null;
            let popup: TippyInstance | null = null;

            return {
              onStart: (props) => {
                component = new ReactRenderer(MentionList, {
                  props,
                  editor: props.editor,
                });
                if (!props.clientRect) return;
                popup = tippy(document.body, {
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: "manual",
                  placement: "bottom-start",
                });
              },
              onUpdate: (props) => {
                component?.updateProps(props);
                if (!props.clientRect) return;
                popup?.setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                });
              },
              onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                  popup?.hide();
                  return true;
                }
                return component?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                popup?.destroy();
                component?.destroy();
                popup = null;
                component = null;
              },
            };
          },
        },
      }),
    ],
    content: value || "",
    editable: !disabled,
    autofocus: autoFocus,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "tiptap max-w-none focus:outline-none min-h-[72px] text-sm leading-relaxed",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit?.();
          return true;
        }
        return false;
      },
      // Drag-and-drop a file onto the editor → upload + insert. Returning
      // true prevents ProseMirror from also trying to handle the drop as
      // text/HTML (which it would garble the binary into).
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const dt = event.dataTransfer;
        if (!dt || dt.files.length === 0) return false;
        const files = Array.from(dt.files);
        event.preventDefault();
        void handleFiles(files);
        return true;
      },
      // Paste an image (e.g. screenshot from clipboard) → upload + insert.
      // Pure-text paste falls through to the default handler so plain text
      // and rich-text paste keep working.
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const fileItems = Array.from(items).filter(
          (it) => it.kind === "file",
        );
        if (fileItems.length === 0) return false;
        const files = fileItems
          .map((it) => it.getAsFile())
          .filter((f): f is File => f !== null);
        if (files.length === 0) return false;
        event.preventDefault();
        void handleFiles(files);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!editor) return;
      setUploadError(null);
      setUploading(true);
      try {
        for (const file of files) {
          const result = await uploadCommentAttachment(file);
          insertUploadedFile(editor, result);
        }
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [editor, insertUploadedFile],
  );

  const onPickFile = () => fileInputRef.current?.click();
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) void handleFiles(files);
    // Reset so picking the same file twice in a row still fires onChange.
    e.target.value = "";
  };

  // Keep editor in sync when the parent resets `value` (e.g. after posting).
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [disabled, editor]);

  return (
    <div className="rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
      <Toolbar
        editor={editor}
        onPickFile={onPickFile}
        uploading={uploading}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      <div className="px-3 py-2">
        <EditorContent editor={editor} />
      </div>
      {uploadError && (
        <div className="border-t border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {uploadError}
        </div>
      )}
      {uploading && !uploadError && (
        <div className="border-t border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          Uploading…
        </div>
      )}
    </div>
  );
}

function Toolbar({
  editor,
  onPickFile,
  uploading,
}: {
  editor: Editor | null;
  onPickFile: () => void;
  uploading: boolean;
}) {
  if (!editor) return null;

  const promptForLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previous ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const normalized = /^https?:\/\//i.test(url) || /^mailto:/i.test(url)
      ? url
      : `https://${url}`;
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: normalized })
      .run();
  };

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
      <ToolbarButton
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-3.5" />
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        label="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-3.5" />
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        label="Link"
        active={editor.isActive("link")}
        onClick={promptForLink}
      >
        <LinkIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label={uploading ? "Uploading…" : "Attach image or PDF"}
        active={false}
        onClick={onPickFile}
        disabled={uploading}
      >
        <Paperclip className="size-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}
