import { cn } from "@/lib/utils";

type IconProps = { className?: string };

// Threads uses stroke-based glyphs at roughly 1.75 weight on 24x24. These are
// hand-traced from the real embed so they line up with what users see on
// threads.net rather than lucide's generic set.

export function ThreadsHeartIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[22px] w-[22px]", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="M12 20.5c-.7 0-1.38-.25-1.92-.71C7.76 17.96 3 13.83 3 9.5 3 6.91 5.01 5 7.35 5c1.55 0 3 .85 3.74 2.17a.6.6 0 0 0 1.02 0C12.85 5.85 14.3 5 15.85 5 18.19 5 20.2 6.91 20.2 9.5c0 4.33-4.76 8.46-7.08 10.29-.54.46-1.22.71-1.92.71h-.2Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThreadsCommentIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[22px] w-[22px]", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="M20.5 11.5c0 4.69-3.81 8.5-8.5 8.5-1.39 0-2.7-.33-3.86-.93L4 20l.93-4.14C4.33 14.7 4 13.39 4 12 4 7.31 7.81 3.5 12.5 3.5 17.19 3.5 20.5 7.31 20.5 11.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThreadsRepostIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[22px] w-[22px]", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5M17 7v5M7 17v-5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThreadsShareIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[22px] w-[22px]", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="m21 3-9 9M21 3l-6 18-3-9-9-3 18-6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Three-dot menu at the right of each post header.
export function ThreadsMoreIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[18px] w-[18px]", className)}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
