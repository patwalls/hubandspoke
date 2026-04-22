import { cn } from "@/lib/utils";

export function VerifiedBadge({
  className,
  tone = "instagram",
}: {
  className?: string;
  tone?: "instagram" | "x" | "tiktok";
}) {
  const fill =
    tone === "x" ? "#1d9bf0" : tone === "tiktok" ? "#20d5ec" : "#3897f0";
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("inline-block h-3.5 w-3.5 shrink-0", className)}
      aria-label="Verified"
    >
      <path
        fill={fill}
        d="M23 12l-2.5-2.9.4-3.8-3.7-.8-1.9-3.3L11.6 2 8 .4 6.1 3.7l-3.7.8.4 3.8L.3 11.2 3 14l-.4 3.8 3.7.8L8.3 22l3.6-1.6 3.6 1.6 1.9-3.3 3.7-.8-.4-3.8L23 12zm-12.3 4.5L6 11.8l1.4-1.4 3.3 3.3 6-6 1.4 1.4-7.4 7.4z"
      />
    </svg>
  );
}
