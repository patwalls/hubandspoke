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
import { markShots, shotFor, ShotBlock, type PreviewScreenshots, type Shot } from "@/components/dashboard/preview-screenshots";
import { EditableSection, emptySectionHint, type PreviewEditing } from "@/components/dashboard/editable-section";
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
  const components: Components = {
    p: (props) => <p style={asStyle(t.p)}>{props.children}</p>,
    h1: (props) => <h1 style={asStyle(t.h1)}>{props.children}</h1>,
    h2: (props) => <h2 style={asStyle(t.h2)}>{props.children}</h2>,
    h3: (props) => <h3 style={asStyle(t.h3)}>{props.children}</h3>,
    ul: (props) => <ul style={asStyle(t.ul)}>{props.children}</ul>,
    ol: (props) => <ol style={asStyle(t.ol)}>{props.children}</ol>,
    li: (props) => <li style={asStyle(t.li)}>{props.children}</li>,
    a: (props) => (
      <a href={props.href} target="_blank" rel="noreferrer" style={asStyle(t.a)}>
        {props.children}
      </a>
    ),
    img: (props) => {
      const shot = shotFor(props.alt, shots);
      if (shot) return <ShotBlock shot={shot} edit={edit} />;
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
      let md = markShots(sec.key, (byKey.get(sec.key) ?? "").trim(), screenshots, shots);
      if (sec.kind === "sponsor" && sponsor?.copy?.trim()) md = sponsorBlock(sponsor.copy, sponsor.landingUrl);
      let content = md ? <ReactMarkdown components={components}>{md}</ReactMarkdown> : null;
      if (!content && showHints) content = <p style={asStyle(css.hint)}>{sec.hint || "(content)"}</p>;
      if (edit) {
        content = (
          <EditableSection sectionKey={sec.key} markdown={byKey.get(sec.key) ?? ""} isSponsor={sec.kind === "sponsor"} edit={edit}>
            {content ?? emptySectionHint(sec.hint)}
          </EditableSection>
        );
      }
      if (content && sec.boxColor) content = <div style={asStyle(css.box(sec.boxColor))}>{content}</div>;
      const heading = sec.heading ? (
        sec.pillColor ? (
          <div style={asStyle(css.pillWrap)}>
            <span style={asStyle(css.pill(sec.pillColor))}>{sec.heading}</span>
          </div>
        ) : (
          <div style={asStyle(css.plainHeading(sec.headingLevel))}>{sec.heading}</div>
        )
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
          {img && <div style={asStyle(css.mastheadWrap)}>{st.mastheadLinkUrl ? <a href={st.mastheadLinkUrl} target="_blank" rel="noreferrer">{img}</a> : img}</div>}
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
