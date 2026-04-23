import { Mail, Circle, AtSign, type LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLATFORM_META, toPlatform, type Platform } from "@/lib/platforms";

interface PlatformIconProps {
  platform: Platform | string | null | undefined;
  size?: number;
  className?: string;
  /** Override default platform color with `currentColor` (e.g. inside a
   *  colored pill where the icon should match the text color). */
  inheritColor?: boolean;
}

/**
 * Brand marks for each supported platform. `lucide-react` v1.x dropped the
 * brand set, so we inline the SVGs here — small (<1KB total), locked to
 * brand guidelines. Viewboxes are platform-native (most 24×24, YouTube
 * 28×20-ish, Threads 192×192). `size` controls the rendered pixel size;
 * `currentColor` lets callers tint them for hover/active states.
 */

function YouTubeIcon({ size = 16, className, ...rest }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 28 20"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M27.426 3.167a3.52 3.52 0 0 0-2.477-2.493C22.763 0 14 0 14 0S5.237 0 3.05.674A3.52 3.52 0 0 0 .574 3.167C0 5.367 0 10 0 10s0 4.633.574 6.833a3.52 3.52 0 0 0 2.477 2.493C5.237 20 14 20 14 20s8.763 0 10.949-.674a3.52 3.52 0 0 0 2.477-2.493C28 14.633 28 10 28 10s0-4.633-.574-6.833ZM11.2 14.286V5.714L18.4 10l-7.2 4.286Z" />
    </svg>
  );
}

function InstagramIcon({ size = 16, className, ...rest }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M12 2.2c3.2 0 3.584.012 4.849.07 1.17.055 1.805.249 2.227.415.56.217.96.477 1.38.897.42.42.68.82.897 1.38.166.422.36 1.057.415 2.227.058 1.265.07 1.646.07 4.85 0 3.204-.012 3.584-.07 4.85-.055 1.17-.249 1.805-.415 2.227-.217.56-.477.96-.897 1.38-.42.42-.82.68-1.38.897-.422.166-1.057.36-2.227.415-1.265.058-1.646.07-4.85.07-3.204 0-3.584-.012-4.85-.07-1.17-.055-1.805-.249-2.227-.415a3.72 3.72 0 0 1-1.38-.897 3.72 3.72 0 0 1-.897-1.38c-.166-.422-.36-1.057-.415-2.227-.058-1.265-.07-1.646-.07-4.85 0-3.204.012-3.584.07-4.85.055-1.17.249-1.805.415-2.227.217-.56.477-.96.897-1.38.42-.42.82-.68 1.38-.897.422-.166 1.057-.36 2.227-.415C8.416 2.212 8.797 2.2 12 2.2ZM12 0C8.741 0 8.333.014 7.053.072 5.775.131 4.902.333 4.14.63a5.92 5.92 0 0 0-2.14 1.393A5.92 5.92 0 0 0 .63 4.163C.333 4.925.131 5.798.072 7.076.014 8.356 0 8.764 0 12.023c0 3.259.014 3.668.072 4.948.059 1.277.261 2.15.558 2.912.31.8.718 1.479 1.393 2.153.675.675 1.354 1.084 2.153 1.393.761.297 1.634.499 2.912.558C8.333 23.986 8.741 24 12 24s3.667-.014 4.947-.072c1.278-.059 2.15-.261 2.912-.558a5.92 5.92 0 0 0 2.153-1.393 5.92 5.92 0 0 0 1.393-2.153c.297-.761.499-1.634.558-2.912.058-1.28.072-1.689.072-4.948 0-3.259-.014-3.667-.072-4.947-.059-1.278-.261-2.151-.558-2.913a5.92 5.92 0 0 0-1.393-2.14A5.92 5.92 0 0 0 19.86.63C19.097.333 18.225.131 16.947.072 15.667.014 15.259 0 12 0Zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.406-11.845a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88Z" />
    </svg>
  );
}

function XIcon({ size = 16, className, ...rest }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TikTokIcon({ size = 16, className, ...rest }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z" />
    </svg>
  );
}

function LinkedinIcon({ size = 16, className, ...rest }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.852 3.37-1.852 3.601 0 4.267 2.37 4.267 5.455v6.288zM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124zM7.119 20.452H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// The official Threads brand mark reads as a muddy "@"-glyph at 14–16px.
// Lucide's `AtSign` is cleaner and semantically close (Threads' whole
// identity is the @-handle), so we use it in place of the brand mark for
// small badges. Keep this as a small wrapper so callers can still import
// a `ThreadsIcon` named export if we ever want to re-introduce the logo.
function ThreadsBrandIcon({ size = 16, className, ...rest }: LucideProps) {
  return <AtSign size={size} className={className} aria-hidden {...rest} />;
}

/**
 * Render the brand logo for a platform at a given size. Color defaults to
 * the platform's brand-adjacent class from `PLATFORM_META`; pass
 * `inheritColor` to pick up the parent text color.
 */
export function PlatformIcon({
  platform,
  size = 14,
  className,
  inheritColor,
}: PlatformIconProps) {
  const p = toPlatform(platform);
  const colorCls = inheritColor ? "" : PLATFORM_META[p].colorClass;
  const cls = cn("shrink-0", colorCls, className);

  switch (p) {
    case "youtube":
      return <YouTubeIcon size={size} className={cls} />;
    case "instagram":
      return <InstagramIcon size={size} className={cls} />;
    case "x":
      return <XIcon size={size} className={cls} />;
    case "tiktok":
      return <TikTokIcon size={size} className={cls} />;
    case "linkedin":
      return <LinkedinIcon size={size} className={cls} />;
    case "threads":
      return <ThreadsBrandIcon size={size} className={cls} />;
    case "newsletter":
      return <Mail size={size} className={cls} aria-hidden />;
    case "other":
      return <Circle size={size} className={cls} aria-hidden />;
  }
}
