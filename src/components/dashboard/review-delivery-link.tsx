"use client";

import { useEffect, useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { trackUsage } from "@/lib/usage/track";
import type { DeliveryLink } from "@/lib/production/delivery-link";

/**
 * "↗ YouTube Studio" beside the status on a post in Review: the link the
 * editor handed the work back with (the upload, the Canva design), so the
 * reviewer opens it without scrolling to the comments. Same pick as the In
 * Production list's Review rows. Renders nothing when there's no link.
 */
export function ReviewDeliveryLink({
  brand,
  itemId,
  status,
  refreshKey,
}: {
  brand: string;
  itemId: string;
  status: string;
  refreshKey?: string | number;
}) {
  const [link, setLink] = useState<DeliveryLink | null>(null);
  const inReview = status === "Review";

  useEffect(() => {
    if (!inReview) return;
    let cancelled = false;
    fetch(`/api/production-items/${itemId}/delivery-link`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { link: DeliveryLink | null } | null) => {
        if (!cancelled) setLink(d?.link ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, inReview, refreshKey]);

  if (!inReview || !link) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="post-delivery-link"
      onClick={() => trackUsage("content:delivery-link", brand)}
      title={`${link.by ? `${link.by}'s` : "The"} link from the comments`}
      className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <ArrowUpRightIcon className="size-3" aria-hidden />
      {link.label}
    </a>
  );
}
