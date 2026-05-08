import { cn } from "@/lib/utils";
import { authorInitials } from "./resolve-preview-data";

// Deterministic pastel color per handle so the same author looks the same
// across preview cards. Based on a tiny string hash modulo a curated palette
// that reads well on both light and dark backgrounds.
const PALETTE = [
  "bg-pink-400",
  "bg-rose-400",
  "bg-orange-400",
  "bg-amber-400",
  "bg-lime-400",
  "bg-emerald-400",
  "bg-teal-400",
  "bg-cyan-400",
  "bg-sky-400",
  "bg-indigo-400",
  "bg-violet-400",
  "bg-fuchsia-400",
];

function pickColor(seed: string | null): string {
  if (!seed) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function MonogramAvatar({
  displayName,
  handle,
  avatarUrl,
  size = "md",
  className,
}: {
  displayName: string | null;
  handle: string | null;
  /** When set, renders the actual profile pic. Falls back to a deterministic
   *  pastel monogram when null OR when the image fails to load (no auth on
   *  IG CDN — can fail silently). */
  avatarUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const initial = authorInitials(displayName, handle);
  const color = pickColor(handle ?? displayName);
  const sizeClass =
    size === "sm"
      ? "h-7 w-7 text-[11px]"
      : size === "lg"
        ? "h-12 w-12 text-base"
        : "h-9 w-9 text-xs";
  if (avatarUrl) {
    return (
      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-full",
          sizeClass,
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        sizeClass,
        color,
        className,
      )}
      aria-hidden
    >
      {initial}
    </div>
  );
}
