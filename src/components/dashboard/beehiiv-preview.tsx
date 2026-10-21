"use client";

// The beehiiv email as the push builds it (beehiiv-draft.ts), drawn from the
// same `template.beehiiv.layout`: masthead, the bordered cards with their
// labels, outro image, the feedback poll, and a note for the footer (it comes
// from the "Hub & Spoke" template in beehiiv). So the format page and the
// editor show what lands in beehiiv.

import ReactMarkdown from "react-markdown";
import { sponsorBlock, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

/** "### Why Claude Works" → "Claude" — same rule as the push's card labels. */
function toolFromWhy(md: string): string | null {
  const m = md.match(/Why\s+(.+?)\s+Works/i);
  return m ? m[1].replace(/[*_#]/g, "").trim() : null;
}

export function BeehiivPreview({
  template,
  sections = [],
  sponsor = null,
  showHints = false,
  scale = 1,
  clipHeight,
  className,
}: {
  template: NewsletterTemplate;
  sections?: NewsletterSection[];
  sponsor?: { copy: string | null; landingUrl: string | null } | null;
  showHints?: boolean;
  scale?: number;
  clipHeight?: number;
  className?: string;
}) {
  const layout = template.beehiiv?.layout;
  if (!layout) return null;
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));
  const secByKey = new Map(template.sections.map((s) => [s.key, s]));
  const md = (key: string) => {
    const sec = secByKey.get(key);
    if (sec?.kind === "sponsor" && sponsor?.copy?.trim()) return sponsorBlock(sponsor.copy, sponsor.landingUrl);
    return (byKey.get(key) ?? "").trim();
  };
  const tool = toolFromWhy(md("why")) ?? (showHints ? "[Tool]" : "AI");
  const placed = new Set(layout.cards.flatMap((c) => c.sections.map((x) => x.key)));
  const unplaced = template.sections.filter((s) => !placed.has(s.key));

  const body = (key: string, linkButtons: boolean) => {
    const text = md(key);
    if (!text) {
      return showHints ? <p className="text-[13px] italic text-[#9ca3af]">{secByKey.get(key)?.hint || `(${key})`}</p> : null;
    }
    return (
      <ReactMarkdown
        components={{
          p: ({ children, node }) => {
            const only = node?.children?.length === 1 && node.children[0].type === "element" && node.children[0].tagName === "a";
            return linkButtons && only ? (
              <p className="my-3">
                <span className="inline-block rounded-lg px-5 py-3 text-[15px] text-white" style={{ background: layout.buttonColor }}>
                  {children}
                </span>
              </p>
            ) : (
              <p className="my-2 text-[15px] leading-relaxed">{children}</p>
            );
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline" style={{ color: linkButtons ? "inherit" : "#3e81de" }}>
              {children}
            </a>
          ),
          h2: ({ children }) => <h2 className="my-3 text-xl font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="my-3 text-lg font-semibold">{children}</h3>,
          ul: ({ children }) => <ul className="my-2 list-disc pl-5 text-[15px]">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-5 text-[15px]">{children}</ol>,
          // eslint-disable-next-line @next/next/no-img-element
          img: ({ src, alt }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 w-full rounded" />,
        }}
      >
        {text}
      </ReactMarkdown>
    );
  };

  const cards = [
    ...layout.cards,
    ...(unplaced.length ? [{ label: "", border: "#9ca3af", background: "#FFFFFF", sections: unplaced.map((s) => ({ key: s.key, showHeading: !!s.heading, linkButtons: false })) }] : []),
  ];

  const email = (
    <div className="bg-[#f4f9fc] px-4 py-6 text-[#222222]" style={{ fontFamily: "Poppins, 'Open Sans', Helvetica, Arial, sans-serif" }}>
      <div className="mx-auto flex max-w-[600px] flex-col gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {layout.mastheadImageUrl && <img src={layout.mastheadImageUrl} alt="" className="w-full rounded-xl" />}
        {cards.map((c, i) => (
          <div key={i} className="rounded-[5px] px-5 py-3" style={{ border: `2px solid ${c.border}`, background: c.background }}>
            {c.label.trim() && (
              <div className="mt-1 text-[17px] font-semibold" style={{ color: layout.labelColor }}>
                {c.label.replace(/\{tool\}/g, tool)}
              </div>
            )}
            {c.sections.map((s) => (
              <div key={s.key}>
                {s.showHeading && secByKey.get(s.key)?.heading && <h3 className="my-3 text-lg font-semibold">{secByKey.get(s.key)!.heading}</h3>}
                {body(s.key, s.linkButtons)}
              </div>
            ))}
          </div>
        ))}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {layout.outroImageUrl && <img src={layout.outroImageUrl} alt="" className="w-full rounded-xl" />}
        {layout.poll && (
          <div className="rounded-[5px] px-5 py-4" style={{ border: "2px solid #273653", background: "#FFFFFF" }}>
            <div className="text-lg font-semibold">How was Futurepedia today?</div>
            {["It was epic! 💥", "Just okay. 👌", "Not good! ❌"].map((o) => (
              <div key={o} className="mt-2 w-2/3 rounded border border-[#d1d5db] px-3 py-1.5 text-[14px] text-[#49ADFF]">
                {o}
              </div>
            ))}
          </div>
        )}
        <p className="text-center text-[11px] text-[#9ca3af]">Footer (social icons, other newsletters, unsubscribe) comes from the “Hub &amp; Spoke” template in beehiiv.</p>
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
