"use client";

// The newsletter rendered as its email, in the browser: masthead, plain or
// pill headings, tinted boxes, dividers — every style from emailCss(), the
// same map renderEmailHtml uses for the sent email, so they can't drift.
// `scale` shrinks it into a thumbnail (the format page's template card).
// With `edit` it is the newsletter editor's canvas: click a section to edit it
// in place (EditableSection — the same behavior for every newsletter).

import type { CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { BeehiivPreview } from "@/components/dashboard/beehiiv-preview";
import { imageFor, ImageBlock, markImages, markShots, ScreenshotSample, shotFor, ShotBlock, ThumbnailSample, type DraftImage, type PreviewScreenshots, type Shot } from "@/components/dashboard/preview-screenshots";
import { EditableSection, emptySectionHint, FixedPart, type PreviewEditing } from "@/components/dashboard/editable-section";
import { emailCss, sponsorBlock, type CssProps, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

const asStyle = (c: CssProps) => c as CSSProperties;

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
}) {
  // beehiiv formats (Futurepedia): draw the card layout the push builds.
  if (template.beehiiv?.layout) {
    return <BeehiivPreview template={template} sections={sections} sponsor={sponsor} showHints={showHints} scale={scale} clipHeight={clipHeight} className={className} edit={edit} screenshots={screenshots} />;
  }
  const st = template.style;
  const css = emailCss(st);
  const t = css.tags;
  const shots: Shot[] = [];
  const images: DraftImage[] = [];
  /** Draft canvas: images are clickable blocks. */
  const draftCanvas = !!edit && edit.mode !== "template";
  const components: Components = {
    p: (props) => <p style={asStyle(t.p)}>{props.children}</p>,
    h1: (props) => <h1 style={asStyle(t.h1)}>{props.children}</h1>,
    h2: (props) => <h2 style={asStyle(t.h2)}>{props.children}</h2>,
    h3: (props) => <h3 style={asStyle(t.h3)}>{props.children}</h3>,
    ul: (props) => <ul style={asStyle(t.ul)}>{props.children}</ul>,
    // Keep a list's own start number (numbered steps split by images are separate lists).
    ol: (props) => <ol start={props.start} style={asStyle(t.ol)}>{props.children}</ol>,
    li: (props) => <li style={asStyle(t.li)}>{props.children}</li>,
    a: (props) => (
      <a href={props.href} target="_blank" rel="noreferrer" style={asStyle(t.a)}>
        {props.children}
      </a>
    ),
    img: (props) => {
      const shot = shotFor(props.alt, shots);
      if (shot) return <ShotBlock shot={shot} edit={edit} />;
      const image = imageFor(props.alt, images);
      if (image && edit) return <ImageBlock image={image} edit={edit} />;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={typeof props.src === "string" ? props.src : undefined} alt={props.alt ?? ""} style={asStyle(t.img)} />;
    },
    blockquote: (props) => <blockquote style={asStyle(t.blockquote)}>{props.children}</blockquote>,
    hr: () => <hr style={asStyle(t.hr)} />,
    code: (props) => <code style={asStyle(t.code)}>{props.children}</code>,
  };
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));

  const blocks = template.sections
    .map((sec) => {
      const raw = (byKey.get(sec.key) ?? "").trim();
      let md = markShots(sec.key, draftCanvas ? markImages(sec.key, raw, images) : raw, screenshots, shots);
      if (sec.kind === "sponsor" && sponsor?.copy?.trim()) md = sponsorBlock(sponsor.copy, sponsor.landingUrl);
      let content = md ? <ReactMarkdown components={components}>{md}</ReactMarkdown> : null;
      if (!content && showHints) {
        content = (
          <>
            {sec.thumbnail && sec.kind !== "sponsor" && <ThumbnailSample />}
            <p style={asStyle(css.hint)}>{sec.hint || "(content)"}</p>
            {sec.screenshots && sec.kind !== "sponsor" && <ScreenshotSample />}
          </>
        );
      }
      // A "label" section (Daily Seinfeld's Read Time): a small rounded label sized to its text, as in the HubSpot email.
      if (content && sec.look === "label") {
        content = (
          <div
            className="[&_p]:m-0!"
            style={{ display: "inline-block", background: sec.boxColor ?? "#e2e8f0", color: "rgb(3, 2, 18)", fontWeight: 700, lineHeight: "120%", padding: 8, borderRadius: 4 }}
          >
            {content}
          </div>
        );
      }
      if (edit) {
        content = (
          <EditableSection sectionKey={sec.key} markdown={edit.mode === "template" ? sec.hint : (byKey.get(sec.key) ?? "")} isSponsor={sec.kind === "sponsor"} edit={edit}>
            {content ?? emptySectionHint(sec.hint)}
          </EditableSection>
        );
      }
      if (content && sec.boxColor && sec.look !== "label") content = <div style={asStyle(css.box(sec.boxColor))}>{content}</div>;
      const heading = sec.heading ? (
        <FixedPart
          edit={edit}
          reason={template.hubspot?.blocks[sec.key] ? "Heading: from the HubSpot template email" : "Heading: set in the template"}
          onSelect={edit ? () => edit.onSelectSection(sec.key) : undefined}
          lockedInTemplate={template.hubspot?.blocks[sec.key] ? "Set in the HubSpot template email: change it there" : null}
        >
          {sec.pillColor ? (
            <div style={asStyle(css.pillWrap)}>
              <span style={asStyle(css.pill(sec.pillColor))}>{sec.heading}</span>
            </div>
          ) : (
            <div style={asStyle(css.plainHeading(sec.headingLevel))}>{sec.heading}</div>
          )}
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

  const img = st.mastheadImageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={st.mastheadImageUrl} alt="" style={asStyle(css.mastheadImg)} />
  ) : null;

  const email = (
    <div style={asStyle(css.outer)}>
      <div style={asStyle(css.card)}>
        <div style={asStyle(css.inner)}>
          {img && (
            <FixedPart edit={edit} reason={template.hubspot ? "Masthead: from the HubSpot template email" : "Masthead: set in the template"}>
              <div style={asStyle(css.mastheadWrap)}>{st.mastheadLinkUrl ? <a href={st.mastheadLinkUrl} target="_blank" rel="noreferrer">{img}</a> : img}</div>
            </FixedPart>
          )}
          {blocks.map((b, i) => (
            <div key={i}>
              {i > 0 && (st.dividers ? <hr style={asStyle(css.divider)} /> : <div style={asStyle(css.gap)} />)}
              {b}
            </div>
          ))}
        </div>
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
