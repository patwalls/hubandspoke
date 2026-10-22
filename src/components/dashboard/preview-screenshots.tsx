"use client";

// Screenshot placeholders on a newsletter preview, shared by both previews
// (HubSpot templates and the beehiiv card layout): each placeholder becomes
// an image marker the preview's img renderer hands to ShotBlock, which draws
// the picked image, a "grabbing…" state, or a "screenshot goes here" box. On
// the editor's canvas a shot is clickable (opens its side panel) and accepts
// a dropped image file.

import { Camera, ImageIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimestamp, replaceScreenshotMarks, screenshotKey, type ChosenScreenshot } from "@/lib/newsletter-screenshots";
import type { PreviewEditing } from "@/components/dashboard/editable-section";

export interface PreviewScreenshots {
  chosen: Record<string, ChosenScreenshot>;
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null;
}

export interface Shot {
  sectionKey: string;
  markKey: string;
  sec: number | null;
  label: string;
  url: string | null;
  pending: boolean;
}

/** Alt-text prefix marking a placeholder; the number indexes the render's shot list. */
const SHOT = "__shot__";

/** Replace a section's placeholders with image markers, collecting them into `shots`. */
export function markShots(sectionKey: string, markdown: string, screenshots: PreviewScreenshots | undefined, shots: Shot[]): string {
  return replaceScreenshotMarks(markdown, (sec, label) => {
    const markKey = screenshotKey(sectionKey, label);
    const c = screenshots?.chosen[markKey];
    shots.push({ sectionKey, markKey, sec, label, url: c ? screenshots!.urlFor(c, markKey) : null, pending: !!c?.pending });
    return `\n![${SHOT}${shots.length - 1}](#screenshot)\n`;
  });
}

/** The shot an img renderer's alt text points at (null: an ordinary image). */
export function shotFor(alt: string | null | undefined, shots: Shot[]): Shot | null {
  return alt?.startsWith(SHOT) ? (shots[Number(alt.slice(SHOT.length))] ?? null) : null;
}

export interface DraftImage {
  sectionKey: string;
  /** Its order among the section's images. */
  index: number;
  url: string;
  alt: string;
}

const IMG = "__img__";
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** A YouTube thumbnail link (what the drafter places for a "Video thumbnail" section). */
export function isVideoThumbnail(url: string): boolean {
  return /img\.youtube\.com\/vi\//.test(url) || /i\.ytimg\.com\/vi\//.test(url);
}

/** Draft canvas: turn a section's images into markers ImageBlock draws (clickable), collecting them into `images`. */
export function markImages(sectionKey: string, markdown: string, images: DraftImage[]): string {
  let index = 0;
  return markdown.replace(MD_IMAGE, (_m, alt: string, url: string) => {
    images.push({ sectionKey, index: index++, url, alt });
    return `![${IMG}${images.length - 1}](${url})`;
  });
}

export function imageFor(alt: string | null | undefined, images: DraftImage[]): DraftImage | null {
  return alt?.startsWith(IMG) ? (images[Number(alt.slice(IMG.length))] ?? null) : null;
}

/** An image in a draft on the canvas: click for its panel (upload / frame / thumbnail / remove), or drop a file on it. */
export function ImageBlock({ image, edit }: { image: DraftImage; edit: PreviewEditing }) {
  const selected = edit.selected === `img:${image.sectionKey}:${image.index}`;
  return (
    <span
      role="button"
      tabIndex={0}
      title="Click to change or remove this image"
      onClick={(e) => {
        e.stopPropagation();
        edit.onSelectImage?.(image.sectionKey, image.index);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.stopPropagation();
        edit.onSelectImage?.(image.sectionKey, image.index);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = e.dataTransfer.files?.[0];
        if (f?.type.startsWith("image/")) edit.onDropImage?.(image.sectionKey, image.index, f);
      }}
      className={cn(
        "group relative my-3 block cursor-pointer rounded-[12px] outline-offset-2",
        selected ? "outline-2 outline-[#49adff] outline-solid" : "hover:outline-2 hover:outline-[#49adff]/60 hover:outline-solid",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={image.alt} style={{ display: "block", width: "100%", borderRadius: 10 }} />
      {isVideoThumbnail(image.url) && (
        <span className="absolute left-2 top-2 rounded bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-[#222] shadow">Video thumbnail</span>
      )}
      <span className="absolute right-2 top-2 rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-[#222] opacity-0 shadow group-hover:opacity-100">Change</span>
    </span>
  );
}

/** Template preview: where a section's video thumbnail goes (its "Video thumbnail" setting is on). */
export function ThumbnailSample() {
  return (
    <span className="my-3 flex aspect-video w-full flex-col items-center justify-center gap-0.5 rounded-[10px] border-2 border-dashed border-[#c7d2dc] bg-[#eef2f6] px-6 text-center text-[13px] not-italic leading-normal text-[#6b7280]">
      <span className="flex items-center gap-1.5 font-semibold">
        <ImageIcon className="size-3.5" /> Video thumbnail
      </span>
      <span>Pulled from the video each draft. Swap or upload in the draft editor.</span>
    </span>
  );
}

/** Template preview: where a section's screenshots go (its "Screenshots from the video" setting is on). */
export function ScreenshotSample() {
  return (
    <span className="my-3 flex w-full flex-col items-center justify-center gap-0.5 rounded-[10px] border-2 border-dashed border-[#c7d2dc] bg-[#f7fafc] px-6 py-5 text-center text-[13px] not-italic leading-normal text-[#6b7280]">
      <span className="flex items-center gap-1.5 font-semibold">
        <Camera className="size-3.5" /> Screenshots go here in each draft
      </span>
      <span>AI marks the right moments in the video; Hub &amp; Spoke grabs those frames. Swap or upload in the draft editor.</span>
    </span>
  );
}

export function ShotBlock({ shot, edit }: { shot: Shot; edit?: PreviewEditing }) {
  const selected = edit?.selected === `shot:${shot.markKey}`;
  const inner = shot.url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={shot.url} alt={shot.label} style={{ display: "block", width: "100%", borderRadius: 10 }} />
  ) : (
    <span className="flex w-full flex-col items-center justify-center gap-0.5 rounded-[10px] border-2 border-dashed border-[#c7d2dc] bg-[#f7fafc] px-6 py-6 text-center text-[13px] leading-normal text-[#6b7280]">
      <span className="flex items-center gap-1.5 font-semibold">
        {shot.pending ? <Loader2 className="size-3.5 animate-spin" /> : edit && <Camera className="size-3.5" />}
        {shot.pending ? "Grabbing frame" : "Screenshot"}
        {shot.sec != null ? ` @ ${formatTimestamp(shot.sec)}` : ""}
      </span>
      <span>{shot.label}</span>
      {edit && !shot.pending && <span className="mt-1 text-[12px] text-[#49adff]">Click to pick a frame, or drop an image here</span>}
    </span>
  );
  if (!edit) return <span className="my-3 block">{inner}</span>;
  return (
    <span
      role="button"
      tabIndex={0}
      title={shot.url ? "Click to change or remove this screenshot" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        edit.onSelectShot(shot.sectionKey, shot.markKey);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.stopPropagation();
        edit.onSelectShot(shot.sectionKey, shot.markKey);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = e.dataTransfer.files?.[0];
        if (f?.type.startsWith("image/")) edit.onDropShot(shot.sectionKey, shot.markKey, f);
      }}
      className={cn(
        "group relative my-3 block cursor-pointer rounded-[12px] outline-offset-2",
        selected ? "outline-2 outline-[#49adff] outline-solid" : "hover:outline-2 hover:outline-[#49adff]/60 hover:outline-solid",
      )}
    >
      {inner}
      {shot.url && (
        <span className="absolute right-2 top-2 rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-[#222] opacity-0 shadow group-hover:opacity-100">Change</span>
      )}
    </span>
  );
}
