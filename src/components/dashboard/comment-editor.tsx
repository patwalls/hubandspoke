"use client";

import { useEffect } from "react";
import { useEditor, EditorContent, ReactRenderer, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Strikethrough } from "lucide-react";
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

export function CommentEditor({
  value,
  onChange,
  onSubmit,
  placeholder = "Write a comment…",
  autoFocus = false,
  disabled = false,
}: CommentEditorProps) {
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
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

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
      <Toolbar editor={editor} />
      <div className="px-3 py-2">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
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
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}
