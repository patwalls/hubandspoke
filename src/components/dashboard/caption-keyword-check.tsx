"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { commentKeywordFor, usesRebrandlyDm } from "@/lib/cta-offer-brands";
import { captionKeywordMismatch, followKeywordInCaption, quotedUpperWords } from "@/lib/dm-keyword-text";
import { trackUsage } from "@/lib/usage/track";

/**
 * One quiet line above an Instagram post's draft when its caption tells
 * people to comment a word that won't DM them this post's link: another
 * post's keyword (copied along with an older caption) or the draft writer's
 * "KEYWORD" placeholder. One click makes the caption say the attached
 * keyword; with none attached, the click opens the keyword dialog (which
 * fills the caption itself). Renders nothing when the caption is fine.
 *
 * The keyword pool is fetched only when the caption quotes an upper-case
 * word that isn't this post's keyword — most captions never trigger it.
 */
export function CaptionKeywordCheck({
  brand,
  slug,
  caption,
  canEdit,
  onFix,
  onAttach,
}: {
  brand: string | null;
  /** The attached keyword's slug (`production_items.short_link_slug`). */
  slug: string | null;
  caption: string | null;
  canEdit: boolean;
  onFix: (caption: string, keyword: string) => Promise<void> | void;
  onAttach: () => void;
}) {
  const keyword = commentKeywordFor(brand, slug);
  const [pool, setPool] = useState<string[] | null>(null);
  const needsPool = !!caption && !!keyword && quotedUpperWords(caption, keyword).length > 0;

  useEffect(() => {
    if (!needsPool || pool) return;
    let cancelled = false;
    const rebrandly = usesRebrandlyDm(brand);
    fetch(rebrandly ? `/api/dm-keywords?brand=${encodeURIComponent(brand ?? "")}` : "/api/short-links?include_archived=true&tag=dm")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { shortLinks?: { slug: string }[] } | null) => {
        if (cancelled || !p?.shortLinks) return;
        setPool(p.shortLinks.map((l) => commentKeywordFor(brand, l.slug)).filter((w): w is string => !!w));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needsPool, pool, brand]);

  const mismatch = caption ? captionKeywordMismatch(caption, { keyword, pool: pool ?? [] }) : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const key = mismatch ? `${mismatch.kind}:${mismatch.says}` : null;
    if (key && seen.current !== key) trackUsage("dm-keyword:caption-mismatch-shown", brand);
    seen.current = key;
  }, [mismatch, brand]);

  if (!caption || !mismatch) return null;
  const word = keyword?.toUpperCase() ?? null;

  return (
    <div data-testid="caption-keyword-check" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        Caption says &ldquo;{mismatch.says}&rdquo;
        {word ? <>, but this post&rsquo;s DM keyword is <span className="font-semibold">{word}</span>.</> : <>. No DM keyword is attached yet.</>}
      </span>
      {canEdit && (
        <button
          type="button"
          className="font-medium underline underline-offset-2 hover:text-amber-950"
          onClick={async () => {
            if (!keyword) {
              trackUsage("dm-keyword:caption-mismatch-attach", brand);
              onAttach();
              return;
            }
            const fixed = followKeywordInCaption(caption, { prev: null, next: keyword, pool: pool ?? [] });
            if (fixed === caption) return;
            trackUsage("dm-keyword:caption-mismatch-fixed", brand);
            await onFix(fixed, keyword);
          }}
        >
          {word ? `Use ${word}` : "Attach a keyword"}
        </button>
      )}
    </div>
  );
}
