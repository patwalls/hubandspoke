"use client";

// The beehiiv email as the push builds it (beehiiv-draft.ts), drawn from the
// same `template.beehiiv.layout`: masthead, the bordered cards with their
// labels, outro image, the feedback poll, and a note for the footer (it comes
// from the "Hub & Spoke" template in beehiiv). So the format page and the
// editor show what lands in beehiiv.

import { Open_Sans, Poppins } from "next/font/google";
import ReactMarkdown from "react-markdown";
import { formatTimestamp, replaceScreenshotMarks } from "@/lib/newsletter-screenshots";
import { sponsorBlock, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

// The Kevin/Saj templates' fonts: Open Sans body (16px, 1.5), Poppins headings.
const openSans = Open_Sans({ subsets: ["latin"], weight: ["400", "600", "700"], style: ["normal", "italic"] });
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "600", "700"] });

/** Alt text marking an unpicked screenshot placeholder (drawn as a "screenshot goes here" box). */
const SHOT = "__shot__";

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
    // Same rules as the push (beehiiv-blocks.ts): every line is its own paragraph, and
    // "- Saj" / "- Kevin" is the intro's sign-off, not a list.
    // Unpicked screenshot placeholders → an image marker the img renderer draws as a box.
    return replaceScreenshotMarks((byKey.get(key) ?? "").trim(), (sec, label) => `\n![${SHOT}${sec != null ? formatTimestamp(sec) : ""}|${label.replace(/[[\]]/g, "")}](#screenshot)\n`)
      .replace(/^- (Saj|Kevin)$/gm, "\\- $1")
      .replace(/\n(?!\n)/g, "\n\n");
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
                <span className="inline-block rounded-lg px-5 py-3 text-[16px] font-semibold text-white" style={{ background: layout.buttonColor }}>
                  {children}
                </span>
              </p>
            ) : (
              <p className="my-3">{children}</p>
            );
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline" style={{ color: linkButtons ? "inherit" : "#3e81de" }}>
              {children}
            </a>
          ),
          h2: ({ children }) => <h2 className={`${poppins.className} my-3 text-[24px] text-[#273653]`}>{children}</h2>,
          h3: ({ children }) => <h3 className={`${poppins.className} my-3 text-[20px] font-bold`}>{children}</h3>,
          h4: ({ children }) => <h4 className={`${poppins.className} my-3 text-[16px] font-bold text-[#00AEEF]`}>{children}</h4>,
          ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
          li: ({ children }) => <li className="my-1">{children}</li>,
          img: ({ src, alt }) => {
            if (alt?.startsWith(SHOT)) {
              const [ts, label] = alt.slice(SHOT.length).split("|");
              return (
                <span className="my-3 flex w-full flex-col items-center justify-center gap-0.5 rounded-[10px] py-6 border-2 border-dashed border-[#c7d2dc] bg-[#f7fafc] px-6 text-center text-[13px] text-[#6b7280]">
                  <span className="font-semibold">Screenshot{ts ? ` @ ${ts}` : ""}</span>
                  <span>{label}</span>
                </span>
              );
            }
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 block w-full rounded-[10px]" />;
          },
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
    <div className={`${openSans.className} bg-[#f4f9fc] px-4 py-6 text-[16px] leading-[1.5] text-[#222222]`}>
      <div className="mx-auto flex max-w-[600px] flex-col gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {layout.mastheadImageUrl && <img src={layout.mastheadImageUrl} alt="" className="w-full rounded-xl" />}
        {cards.map((c, i) => (
          <div key={i} className="rounded-[5px] px-5 py-3" style={{ border: `2px solid ${c.border}`, background: c.background }}>
            {c.label.trim() && (
              <div className={`${poppins.className} mt-1 text-[18px] font-semibold`} style={{ color: layout.labelColor }}>
                {c.label.replace(/\{tool\}/g, tool)}
              </div>
            )}
            {c.sections.map((s) => (
              <div key={s.key}>
                {s.showHeading && secByKey.get(s.key)?.heading && <h3 className={`${poppins.className} my-3 text-[20px] font-bold`}>{secByKey.get(s.key)!.heading}</h3>}
                {body(s.key, s.linkButtons)}
              </div>
            ))}
          </div>
        ))}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {layout.outroImageUrl && <img src={layout.outroImageUrl} alt="" className="w-full rounded-xl" />}
        {layout.poll && (
          <div className="rounded-[5px] px-5 py-4" style={{ border: "2px solid #273653", background: "#FFFFFF" }}>
            <div className={`${poppins.className} text-[18px] font-semibold`}>How was Futurepedia today?</div>
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
