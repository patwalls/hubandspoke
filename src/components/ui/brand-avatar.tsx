"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Circular brand avatar: the brand's uploaded image when present, otherwise a
 * gradient chip with the brand's initials. Shared by the top-nav brand
 * switcher and the dashboard's "Group by → Brand" table rows so a brand looks
 * identical everywhere.
 *
 * `color` is a Tailwind gradient class pair (e.g. "from-emerald-500
 * to-emerald-700") stored on `brands.color`; it drives the initials-fallback
 * background.
 */
export function BrandAvatar({
  label,
  avatarUrl,
  color,
  size = 20,
}: {
  label: string;
  avatarUrl: string | null;
  color: string | null;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);

  const initials = label
    .split(" ")
    .filter((w) => /[A-Za-z0-9]/.test(w[0] ?? ""))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  if (!errored && avatarUrl) {
    return (
      <span
        className="relative shrink-0 inline-block rounded-full overflow-hidden bg-muted"
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt=""
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "rounded-full bg-gradient-to-br text-white font-semibold flex items-center justify-center select-none shrink-0",
        color
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
