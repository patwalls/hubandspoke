"use client";

// The newsletter on screen, as the email itself: the SAME HTML the HubSpot
// push sends (renderEmailParts in newsletter-email-html.ts), drawn section by
// section so the editor can put click-to-edit around each piece. Nothing is
// re-styled here — if it looks right on the canvas it looks right in the
// inbox. `width` draws it at a desktop (600px) or phone width; `scale`
// shrinks it into a thumbnail (the format page's template card). With `edit`
// it is the newsletter editor's canvas: click text to edit it in place
// (EditableSection), click a screenshot spot or an image for its panel, drop
// an image file on either. beehiiv formats keep their own card preview.

import { useMemo, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { BeehiivPreview } from "@/components/dashboard/beehiiv-preview";
import { EditableSection, emptySectionHint, FixedPart, type PreviewEditing } from "@/components/dashboard/editable-section";
import type { PreviewScreenshots } from "@/components/dashboard/preview-screenshots";
import { EMAIL_WIDTH, renderEmailParts } from "@/lib/newsletter-email-html";
import type { NewsletterSection, NewsletterTemplate } from "@/lib/newsletter-template";

/** What stands in for the footer the email tool adds (never part of what we send). */
export const FOOTER_NOTE = "HubSpot adds the footer here when it sends: unsubscribe link, address, social links.";
/** A phone's width on the canvas. */
export const MOBILE_WIDTH = 390;

export function EmailPreview({
  template,
  sections = [],
  sponsor = null,
  showHints = false,
  scale = 1,
  clipHeight,
  className,
  edit,
  screenshots,
  width = EMAIL_WIDTH,
}: {
  template: NewsletterTemplate;
  sections?: NewsletterSection[];
  sponsor?: { copy: string | null; landingUrl: string | null } | null;
  showHints?: boolean;
  scale?: number;
  /** Thumbnail mode: the visible height in px (a scaled element keeps its unscaled layout height). */
  clipHeight?: number;
  className?: string;
  /** The editor's click-to-edit canvas. */
  edit?: PreviewEditing;
  /** Picked images for screenshot placeholders; without it every placeholder draws as a box. */
  screenshots?: PreviewScreenshots;
  /** The email's width on screen: 600 (desktop) or MOBILE_WIDTH. */
  width?: number;
}) {
  // beehiiv formats (Futurepedia): draw the card layout the push builds.
  if (template.beehiiv?.layout) {
    return <BeehiivPreview template={template} sections={sections} sponsor={sponsor} showHints={showHints} scale={scale} clipHeight={clipHeight} className={className} edit={edit} screenshots={screenshots} />;
  }
  return <HtmlEmailPreview template={template} sections={sections} sponsor={sponsor} showHints={showHints} scale={scale} clipHeight={clipHeight} className={className} edit={edit} screenshots={screenshots} width={width} />;
}

function HtmlEmailPreview({
  template,
  sections,
  sponsor,
  showHints,
  scale,
  clipHeight,
  className,
  edit,
  screenshots,
  width,
}: {
  template: NewsletterTemplate;
  sections: NewsletterSection[];
  sponsor: { copy: string | null; landingUrl: string | null } | null;
  showHints: boolean;
  scale: number;
  clipHeight?: number;
  className?: string;
  edit?: PreviewEditing;
  screenshots?: PreviewScreenshots;
  width: number;
}) {
  const st = template.style;
  /** Draft canvas: images and screenshot spots are clickable. */
  const draftCanvas = !!edit && edit.mode !== "template";
  const parts = useMemo(
    () => renderEmailParts({ template, sections, sponsor, showHints, screenshots: screenshots ?? null, canvas: draftCanvas }),
    [template, sections, sponsor, showHints, screenshots, draftCanvas],
  );
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));

  /** A click (or drop) inside a section's HTML: on a screenshot spot or an image, or just the text. */
  const target = (e: MouseEvent | DragEvent) => (e.target as HTMLElement).closest<HTMLElement>("[data-shot],[data-img]");
  const onClick = (sectionKey: string) => (e: MouseEvent<HTMLDivElement>) => {
    if (!draftCanvas) return;
    const el = target(e);
    if (!el) return;
    e.stopPropagation();
    if (el.dataset.shot) edit!.onSelectShot(sectionKey, el.dataset.shot);
    else if (el.dataset.img) edit!.onSelectImage?.(sectionKey, Number(el.dataset.img));
  };
  const onDrop = (sectionKey: string) => (e: DragEvent<HTMLDivElement>) => {
    if (!draftCanvas) return;
    const el = target(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files?.[0];
    if (!f?.type.startsWith("image/")) return;
    if (el.dataset.shot) edit!.onDropShot(sectionKey, el.dataset.shot, f);
    else if (el.dataset.img) edit!.onDropImage?.(sectionKey, Number(el.dataset.img), f);
  };

  const blocks = parts.sections
    .map((part) => {
      const sec = template.sections.find((s) => s.key === part.key)!;
      let content: React.ReactNode = part.content ? (
        <div
          className="nlc-section"
          onClick={onClick(sec.key)}
          onDragOver={draftCanvas ? (e) => target(e) && e.preventDefault() : undefined}
          onDrop={onDrop(sec.key)}
          dangerouslySetInnerHTML={{ __html: part.content }}
        />
      ) : null;
      if (edit) {
        content = (
          <EditableSection sectionKey={sec.key} markdown={edit.mode === "template" ? sec.hint : (byKey.get(sec.key) ?? "")} isSponsor={sec.kind === "sponsor"} edit={edit}>
            {content ?? emptySectionHint(sec.hint)}
            {part.addPoints.length > 0 && (
              <span className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
                {part.addPoints.map((p) => {
                  const busy = edit.addingShot === `${sec.key}:${p.n}`;
                  return (
                    <button
                      key={p.n}
                      type="button"
                      disabled={!!edit.addingShot}
                      onClick={(e) => {
                        e.stopPropagation();
                        edit.onAddShot?.(sec.key, p.n);
                      }}
                      title={`Add a screenshot of step ${p.n}, picked from the video`}
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#c7d2dc] px-2.5 py-0.5 text-[12px] font-medium leading-normal text-[#6b7280] hover:border-[#49adff] hover:text-[#49adff] disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                      {busy ? "Finding the moment…" : `Screenshot for step ${p.n}`}
                    </button>
                  );
                })}
              </span>
            )}
          </EditableSection>
        );
      }
      const heading = part.heading ? (
        <FixedPart edit={edit} reason="Heading: set in the template" onSelect={edit ? () => edit.onSelectSection(sec.key) : undefined}>
          <div dangerouslySetInnerHTML={{ __html: part.heading }} />
        </FixedPart>
      ) : null;
      if (!heading && !content) return null;
      return (
        <div key={sec.key}>
          {heading}
          {content}
        </div>
      );
    })
    .filter(Boolean);

  const selectedShot = edit?.selected?.startsWith("shot:") ? edit.selected.slice(5) : null;
  const selectedImg = edit?.selected?.startsWith("img:") ? edit.selected.slice(4) : null;
  const email = (
    <div style={{ background: st.pageBackground, padding: scale === 1 ? "24px 12px 20px" : 0 }}>
      {draftCanvas && (
        <style>{`
          .nlc-canvas .nlc-shot, .nlc-canvas .nlc-img { cursor: pointer; }
          .nlc-canvas .nlc-shot:hover, .nlc-canvas .nlc-img:hover { outline: 2px solid rgba(73,173,255,.6); outline-offset: 2px; }
          ${selectedShot ? `.nlc-canvas [data-shot=${JSON.stringify(selectedShot)}] { outline: 2px solid #49adff; outline-offset: 2px; }` : ""}
          ${selectedImg ? `.nlc-canvas [data-img=${JSON.stringify(selectedImg.split(":")[1])}] { outline: 2px solid #49adff; outline-offset: 2px; }` : ""}
        `}</style>
      )}
      <div
        style={{ width, maxWidth: "100%", margin: "0 auto", background: parts.background, border: "1px solid #eaf0f6", borderRadius: 12, overflow: "visible", transition: "width .2s ease" }}
      >
        <div
          className="nlc-canvas"
          // The in-place editor (rich-section-editor.tsx) draws links, headings and buttons in the email's colors.
          style={{ ...(parts.bodyStyle as CSSProperties), ["--nl-link" as string]: st.linkColor, ["--nl-heading" as string]: st.headingColor, ["--nl-button" as string]: st.buttonColor ?? st.linkColor }}
        >
          {parts.masthead && (
            <FixedPart edit={edit} reason="Masthead: set in the template's Look" onSelect={edit?.onSelectLook}>
              <div dangerouslySetInnerHTML={{ __html: parts.masthead }} />
            </FixedPart>
          )}
          {blocks.map((b, i) => (
            <div key={i}>
              {i > 0 && <div dangerouslySetInnerHTML={{ __html: parts.divider }} />}
              {b}
            </div>
          ))}
        </div>
        {template.hubspot && (
          <FixedPart edit={edit} reason="Footer: HubSpot adds it from the template email (unsubscribe link, address)">
            <div style={{ borderTop: "1px solid #eaf0f6", padding: "14px 24px", fontFamily: st.fontFamily, fontSize: 12, lineHeight: 1.5, color: "#9ca3af", textAlign: "center" }}>{FOOTER_NOTE}</div>
          </FixedPart>
        )}
      </div>
    </div>
  );

  if (scale === 1) return <div className={className}>{email}</div>;
  return (
    <div className={className} style={{ overflow: "hidden", pointerEvents: "none", height: clipHeight }}>
      <div style={{ width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" }}>{email}</div>
    </div>
  );
}
