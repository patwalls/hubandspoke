"use client";

// The beehiiv email as the push builds it (beehiiv-draft.ts), drawn from the
// same `template.beehiiv.layout`: masthead, the bordered cards with their
// labels, outro image, the feedback poll, and a note for the footer (it comes
// from the "Hub & Spoke" template in beehiiv). So the format page and the
// editor show what lands in beehiiv.
//
// With `edit` it is the newsletter editor's canvas (like the design editor):
// click a section to edit its text in place, click a screenshot to pick or
// upload its image (or drop an image file on it). The editor owns all state.

import { Open_Sans, Poppins } from "next/font/google";
import ReactMarkdown from "react-markdown";
import { EditableSection, emptySectionHint, FixedPart, type PreviewEditing } from "@/components/dashboard/editable-section";
import { cn } from "@/lib/utils";
import { layoutSection } from "@/lib/beehiiv-blocks";
import { imageFor, ImageBlock, markImages, markShots, ScreenshotSample, shotFor, ShotBlock, ThumbnailSample, type DraftImage, type PreviewScreenshots, type Shot } from "@/components/dashboard/preview-screenshots";
import { sponsorBlock, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

// The Kevin/Saj templates' fonts: Open Sans body (16px, 1.5), Poppins headings.
const openSans = Open_Sans({ subsets: ["latin"], weight: ["400", "600", "700"], style: ["normal", "italic"] });
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "600", "700"] });

/** "### Why Claude Works" → "Claude" — same rule as the push's card labels. */
function toolFromWhy(md: string): string | null {
  const m = md.match(/Why\s+(.+?)\s+Works/i);
  return m ? m[1].replace(/[*_#]/g, "").trim() : null;
}

export type { PreviewEditing, PreviewScreenshots };

export function BeehiivPreview({
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
  clipHeight?: number;
  className?: string;
  edit?: PreviewEditing;
  /** Picked images for the placeholders; without it every placeholder draws as a box. */
  screenshots?: PreviewScreenshots;
}) {
  const layout = template.beehiiv?.layout;
  if (!layout) return null;
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));
  const secByKey = new Map(template.sections.map((s) => [s.key, s]));
  const shots: Shot[] = [];
  const images: DraftImage[] = [];
  /** Draft canvas: images are clickable blocks. */
  const draftCanvas = !!edit && edit.mode !== "template";
  const md = (key: string) => {
    const sec = secByKey.get(key);
    if (sec?.kind === "sponsor" && sponsor?.copy?.trim()) return sponsorBlock(sponsor.copy, sponsor.landingUrl);
    // Same rules as the push (beehiiv-blocks.ts): every line is its own paragraph, and
    // "- Saj" / "- Kevin" is the intro's sign-off, not a list. Screenshot placeholders
    // become image markers the img renderer draws (the picked image, or a box).
    // Step titles, bullets and arrows laid out exactly as the push builds them.
    const raw = layoutSection((byKey.get(key) ?? "").trim(), sec?.bullets);
    return markShots(key, draftCanvas ? markImages(key, raw, images) : raw, screenshots, shots)
      .replace(/^- (Saj|Kevin)$/gm, "\\- $1")
      .replace(/(?<! {2})\n(?!\n)/g, "\n\n");
  };
  const tool = toolFromWhy(md("why")) ?? (showHints ? "[Tool]" : "AI");
  const placed = new Set(layout.cards.flatMap((c) => c.sections.map((x) => x.key)));
  const unplaced = template.sections.filter((s) => !placed.has(s.key));

  const rendered = (key: string, linkButtons: boolean) => {
    const text = md(key);
    if (!text) {
      if (showHints) {
        const sec = secByKey.get(key);
        return (
          <>
            <p className="text-[13px] italic text-[#9ca3af]">{sec?.hint || `(${key})`}</p>
            {sec?.thumbnail && sec.kind !== "sponsor" && <ThumbnailSample />}
            {sec?.screenshots && sec.kind !== "sponsor" && <ScreenshotSample />}
          </>
        );
      }
      return edit ? emptySectionHint(secByKey.get(key)?.hint) : null;
    }
    return (
      <ReactMarkdown
        components={{
          p: ({ children, node }) => {
            // A line that is only a link (plus its trailing "→") is a button, as in the push.
            const kids = (node?.children ?? []).filter((c) => !(c.type === "text" && /^\s*(→|->)?\s*$/.test(c.value)));
            const only = kids.length === 1 && kids[0].type === "element" && kids[0].tagName === "a";
            // beehiiv's spacing: text blocks 24px apart, an image 32px from the text around it.
            const image = node?.children?.some((c) => c.type === "element" && c.tagName === "img");
            return linkButtons && only ? (
              <p className="my-6 text-center">
                <span className="inline-block rounded-lg px-5 py-3 text-[16px] font-semibold text-white" style={{ background: layout.buttonColor }}>
                  {children}
                </span>
              </p>
            ) : (
              <p className={image ? "my-8" : "my-6"}>{children}</p>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline"
              style={{ color: linkButtons ? "inherit" : "#3e81de" }}
            >
              {children}
            </a>
          ),
          h2: ({ children }) => <h2 className={`${poppins.className} my-3 text-[24px] text-[#273653]`}>{children}</h2>,
          h3: ({ children }) => <h3 className={`${poppins.className} my-3 text-[20px] font-bold`}>{children}</h3>,
          h4: ({ children }) => <h4 className={`${poppins.className} my-3 text-[16px] font-bold text-[#00AEEF]`}>{children}</h4>,
          ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
          // Keep a list's own start number (steps split by screenshots are separate lists).
          ol: ({ children, start }) => <ol start={start} className="my-3 list-decimal pl-6">{children}</ol>,
          li: ({ children }) => <li className="my-1">{children}</li>,
          img: ({ src, alt }) => {
            const shot = shotFor(alt, shots);
            if (shot) return <ShotBlock shot={shot} edit={edit} />;
            const image = imageFor(alt, images);
            if (image && edit) return <ImageBlock image={image} edit={edit} />;
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 block w-full rounded-[10px]" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    );
  };

  const body = (key: string, linkButtons: boolean) => {
    if (!edit) return rendered(key, linkButtons);
    return (
      <EditableSection sectionKey={key} markdown={edit.mode === "template" ? (secByKey.get(key)?.hint ?? "") : (byKey.get(key) ?? "")} isSponsor={secByKey.get(key)?.kind === "sponsor"} edit={edit}>
        {rendered(key, linkButtons)}
      </EditableSection>
    );
  };

  const cards = [
    ...layout.cards,
    ...(unplaced.length ? [{ label: "", border: "#9ca3af", background: "#FFFFFF", sections: unplaced.map((s) => ({ key: s.key, showHeading: !!s.heading, linkButtons: false })) }] : []),
  ];

  const email = (
    <div className={`${openSans.className} bg-[#f4f9fc] px-4 py-6 text-[16px] leading-[1.5] text-[#222222]`}>
      <div className="mx-auto flex max-w-[600px] flex-col gap-4">
        {layout.mastheadImageUrl && (
          <FixedPart edit={edit} reason="Masthead: set in the template" onSelect={edit?.onSelectLook}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={layout.mastheadImageUrl} alt="" className="w-full rounded-xl" />
          </FixedPart>
        )}
        {cards.map((c, i) => {
          // The plain catch-all card (sections not in any card) isn't a template card.
          const selectCard = edit?.mode === "template" && i < layout.cards.length && edit.onSelectCard ? () => edit.onSelectCard!(i) : undefined;
          return (
            <div
              key={i}
              onClick={
                selectCard
                  ? (e) => {
                      e.stopPropagation();
                      selectCard();
                    }
                  : undefined
              }
              className={cn("rounded-[5px] px-5 py-3", selectCard && "cursor-pointer", selectCard && edit?.selected === `card:${i}` && "outline-2 outline-offset-2 outline-[#49adff] outline-solid")}
              style={{ border: `2px solid ${c.border}`, background: c.background }}
            >
              {c.label.trim() && (
                <FixedPart edit={edit} reason="Card label: set in the template ({tool} comes from the Why section)" onSelect={selectCard}>
                  <div className={`${poppins.className} mt-1 text-[18px] font-semibold`} style={{ color: layout.labelColor }}>
                    {c.label.replace(/\{tool\}/g, tool)}
                  </div>
                </FixedPart>
              )}
              {c.sections.map((s) => (
                <div key={s.key}>
                  {s.showHeading && secByKey.get(s.key)?.heading && (
                    <FixedPart edit={edit} reason="Heading: set in the template" onSelect={edit ? () => edit.onSelectSection(s.key) : undefined}>
                      <h3 className={`${poppins.className} my-3 text-[20px] font-bold`}>{secByKey.get(s.key)!.heading}</h3>
                    </FixedPart>
                  )}
                  {body(s.key, s.linkButtons)}
                </div>
              ))}
            </div>
          );
        })}
        {layout.outroImageUrl && (
          <FixedPart edit={edit} reason="Outro image: set in the template" onSelect={edit?.onSelectLook}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={layout.outroImageUrl} alt="" className="w-full rounded-xl" />
          </FixedPart>
        )}
        {layout.poll && (
          <FixedPart edit={edit} reason="Feedback poll: added by the template" onSelect={edit?.onSelectLook}>
            <div className="rounded-[5px] px-5 py-4" style={{ border: "2px solid #273653", background: "#FFFFFF" }}>
              <div className={`${poppins.className} text-[18px] font-semibold`}>How was Futurepedia today?</div>
              {["It was epic! 💥", "Just okay. 👌", "Not good! ❌"].map((o) => (
                <div key={o} className="mt-2 w-2/3 rounded border border-[#d1d5db] px-3 py-1.5 text-[14px] text-[#49ADFF]">
                  {o}
                </div>
              ))}
            </div>
          </FixedPart>
        )}
        <FixedPart edit={edit} reason="Footer: from beehiiv's “Hub & Spoke” template">
          <p className="text-center text-[11px] text-[#9ca3af]">Footer (social icons, other newsletters, unsubscribe) comes from the “Hub &amp; Spoke” template in beehiiv.</p>
        </FixedPart>
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
