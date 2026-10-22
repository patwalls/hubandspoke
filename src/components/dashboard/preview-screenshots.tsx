"use client";

// Screenshot placeholders on a newsletter preview, shared by both previews
// (HubSpot templates and the beehiiv card layout): each placeholder becomes
// an image marker the preview's img renderer hands to ShotBlock, which draws
// the picked image, a "grabbing…" state, or a "screenshot goes here" box. On
// the editor's canvas a shot is clickable (opens its side panel) and accepts
// a dropped image file.

import { Camera, Loader2 } from "lucide-react";
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
