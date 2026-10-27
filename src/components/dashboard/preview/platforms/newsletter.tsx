"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { NEWSLETTER_EDITOR_CLOSED, NewsletterItemEditor } from "@/components/dashboard/newsletter-item-editor";
import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

interface EditionPreview {
  status: string;
  subject: string | null;
  previewText: string | null;
  html: string | null;
}

/**
 * A newsletter item with an edition (the newsletter editor's draft) previews
 * as the designed email itself — the editor's exact HTML — not the generic
 * inbox mock. Items without one (legacy / no drafter flag) keep the mock.
 */
export function NewsletterSimulator(props: SimulatorProps) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.newsletterDrafter;
  const { edition, loading, reload } = useEditionPreview(props.itemId, enabled);
  if (enabled && loading) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (enabled && edition) return <EditionEmail itemId={props.itemId} edition={edition} onClosed={reload} />;
  return <NewsletterMock {...props} />;
}

function useEditionPreview(itemId: string, enabled: boolean) {
  const [edition, setEdition] = useState<EditionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!enabled) return;
    fetch(`/api/newsletter-drafts/for-item/${itemId}/preview`)
      .then((r) => (r.ok ? (r.json() as Promise<EditionPreview>) : null))
      .then((j) => setEdition(j))
      .catch(() => setEdition(null))
      .finally(() => setLoading(false));
  }, [itemId, enabled]);
  useEffect(reload, [reload]);
  useEffect(() => {
    const onClosed = (e: Event) => {
      if ((e as CustomEvent<{ itemId: string }>).detail?.itemId === itemId) reload();
    };
    window.addEventListener(NEWSLETTER_EDITOR_CLOSED, onClosed);
    return () => window.removeEventListener(NEWSLETTER_EDITOR_CLOSED, onClosed);
  }, [itemId, reload]);
  return { edition, loading: enabled && loading, reload };
}

function EditionEmail({ itemId, edition, onClosed }: { itemId: string; edition: EditionPreview; onClosed: () => void }) {
  const [editorOpen, setEditorOpen] = useState(false);
  return (
    <div className="mx-auto w-full max-w-[640px] space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-background px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{edition.subject || "(no subject)"}</div>
          <div className="truncate text-xs text-muted-foreground">{edition.previewText || "(no preview text)"}</div>
        </div>
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/40"
        >
          <Mail className="size-3" aria-hidden />
          Edit
        </button>
      </div>
      {edition.html ? (
        <EmailFrame html={edition.html} />
      ) : (
        <div className="flex h-40 items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {edition.status === "drafting" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Drafting this issue…
            </>
          ) : (
            "This issue isn't drafted yet — open the editor to draft it."
          )}
        </div>
      )}
      <NewsletterItemEditor itemId={itemId} open={editorOpen} onOpenChange={setEditorOpen} onDone={onClosed} />
    </div>
  );
}

/** The email document in a sandboxed frame (no scripts) sized to its content; links open in a new tab. */
function EmailFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);
  const doc = html.replace("<head>", '<head><base target="_blank">');
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const root = frame.contentDocument?.documentElement;
      if (!root) return;
      setHeight(root.scrollHeight);
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(root.scrollHeight));
      observer.observe(root);
    };
    frame.addEventListener("load", measure);
    return () => {
      frame.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      title="Newsletter email"
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="block w-full rounded-md border border-border bg-white"
      style={{ height }}
    />
  );
}

function NewsletterMock({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const subject = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  // Preview text is the v3 schema's `preview_text` field — the inbox
  // preheader. Not in PLATFORM_FIELD_MAP because it isn't caption/secondary
  // /cta. Read directly by key, falling back to `data.previewText` (which
  // resolve-preview-data fills from `productionItems.newsletterPreviewText`
  // for Klaviyo-synced rows). Legacy v1/v2 drafts without the field hit
  // the same fallback so they still render the enricher's value.
  const previewText = readLive(liveContent, "preview_text", data.previewText ?? "");
  const displayName = data.author.displayName ?? data.author.handle ?? "You";

  return (
    <div className="mx-auto w-full max-w-[600px] overflow-hidden rounded-md border border-border bg-background text-foreground">
      {/* Email header */}
      <div className="border-b border-border bg-muted/40 px-4 py-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          Inbox · from {displayName}
        </div>
        <div className="block">
          <EditableField
            fieldKey={fieldMap.secondary}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={subject}
            placeholder="Subject line…"
            multiline={false}
            className="text-base font-semibold leading-snug"
          />
        </div>
        <div className="mt-1 block">
          <EditableField
            fieldKey="preview_text"
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={previewText}
            placeholder="Preview text…"
            multiline={false}
            className="text-xs text-muted-foreground leading-snug"
          />
        </div>
      </div>

      <div className="flex items-start gap-3 px-4 pt-3">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{displayName}</div>
          <div className="text-xs text-muted-foreground">
            to me · {data.publishedAt ? new Date(data.publishedAt).toLocaleDateString() : "now"}
          </div>
        </div>
      </div>

      <div className="px-4 pb-5 pt-4 text-[14px] leading-relaxed">
        <EditableField
          fieldKey={fieldMap.caption}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={body}
          placeholder="Body copy…"
          multiline
          className="text-[14px] leading-relaxed"
        />
      </div>
    </div>
  );
}
