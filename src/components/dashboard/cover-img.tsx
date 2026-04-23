"use client";

import { useState } from "react";

interface CoverImgProps {
  src: string | null | undefined;
  alt?: string;
  className?: string;
}

// IG/FB CDN URLs (fbcdn.net) stored in `thumbnail` expire after a few
// hours. Rather than render the browser's broken-image icon when a cover
// URL 403s or the content has been removed, hide the <img> entirely —
// callers always have a text fallback adjacent.
export function CoverImg({ src, alt = "", className }: CoverImgProps) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) return null;
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setErrored(true)}
    />
  );
}
