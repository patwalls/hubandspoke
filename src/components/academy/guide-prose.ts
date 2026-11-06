/**
 * Shared typography for the Academy step-by-step guide, used by both the
 * editor and the video page so the guide looks the same while you write it.
 */
export const GUIDE_PROSE = [
  "text-[15px] leading-relaxed text-foreground/90",
  "[&>*+*]:mt-3",
  "[&_h2]:mt-10 [&_h2]:text-[26px] [&_h2]:leading-tight [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&>h2:first-child]:mt-0",
  "[&_h3]:mt-7 [&_h3]:text-[19px] [&_h3]:leading-snug [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-foreground [&>h3:first-child]:mt-0",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
  "[&_a]:font-medium [&_a]:text-orange-600 [&_a]:underline-offset-2 hover:[&_a]:underline",
  "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:mt-1 [&_li>p]:m-0",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_figure]:my-5 [&_figure_img]:w-full [&_figure_img]:rounded-lg [&_figure_img]:border [&_figure_img]:border-border",
  "[&_figcaption]:mt-1.5 [&_figcaption]:text-center [&_figcaption]:text-xs [&_figcaption]:text-muted-foreground",
  "[&_[data-callout]]:rounded-lg [&_[data-callout]]:border [&_[data-callout]]:border-sky-200 [&_[data-callout]]:bg-sky-50 [&_[data-callout]]:px-4 [&_[data-callout]]:py-3",
  "dark:[&_[data-callout]]:border-sky-900 dark:[&_[data-callout]]:bg-sky-950/30",
  "[&_.academy-guide-video]:relative [&_.academy-guide-video]:my-5 [&_.academy-guide-video]:aspect-video [&_.academy-guide-video]:overflow-hidden [&_.academy-guide-video]:rounded-lg [&_.academy-guide-video]:bg-black",
  "[&_.academy-guide-video_iframe]:absolute [&_.academy-guide-video_iframe]:inset-0 [&_.academy-guide-video_iframe]:size-full [&_.academy-guide-video_iframe]:border-0",
].join(" ");
