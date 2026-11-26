"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackUsage } from "@/lib/usage/track";
import { isScanningBrands, parseVisits, recordBrandVisit } from "@/lib/brand-pace/scan";
import { BRAND_PACE_OPEN_KEY } from "./brand-pace-strip";

const VISITS_KEY = "hs:brand-visits";
const SHOWN_KEY = "hs:compare-brands-shown";

/**
 * brands-at-a-glance M2: the way in to /all's "Brands this week" for the
 * people who flip brand dashboards one after another. Renders nothing until
 * this browser has opened 3+ different brand dashboards inside an hour
 * (src/lib/brand-pace/scan.ts); then one small link in the dashboard header
 * that opens /all with the brands line already expanded.
 */
export function CompareBrandsLink({ brand }: { brand: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!brand) return;
    let visits;
    try {
      const now = Date.now();
      visits = recordBrandVisit(parseVisits(localStorage.getItem(VISITS_KEY)), brand, now);
      localStorage.setItem(VISITS_KEY, JSON.stringify(visits));
      const scanning = brand !== "all" && isScanningBrands(visits, now);
      setShow(scanning);
      // Count each scanning stretch once, not every dashboard after the third.
      if (scanning && sessionStorage.getItem(SHOWN_KEY) !== "1") {
        sessionStorage.setItem(SHOWN_KEY, "1");
        trackUsage("dashboard:compare-brands:shown", brand);
      }
    } catch {
      // storage blocked → no link
    }
  }, [brand]);

  if (!show) return null;

  return (
    <Link
      href="/all"
      onClick={() => {
        try {
          localStorage.setItem(BRAND_PACE_OPEN_KEY, "1");
        } catch {}
        trackUsage("dashboard:compare-brands:open", brand);
      }}
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      title="Every brand's week so far, side by side"
      data-testid="compare-brands-link"
    >
      Compare every brand&apos;s week
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}
