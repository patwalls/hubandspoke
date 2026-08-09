import type { ContentReportData, ProductionItem } from "@/types";

/**
 * ContentReportData after client-side rehydration: items carry `account`
 * again, so they satisfy the full ProductionItem shape (all other trimmed
 * report fields are optional on ProductionItem). This is the type components
 * downstream consume; the un-hydrated wire shape must not reach them —
 * the compiler enforces that (ReportItem[] is not assignable where
 * ProductionItem[] is required, because `account` is required).
 */
export type HydratedContentReportData = Omit<ContentReportData, "items"> & {
  items: ProductionItem[];
};

/**
 * Rejoin the deduplicated `accountsById` map onto each report item as
 * `item.account`, restoring the embedded shape every downstream component
 * (AccountBadge, PerformanceTable, CSV export) has always consumed.
 *
 * Defensive on shape: the legacy matg report route still embeds `account`
 * per item (no accountsById) — those pass through untouched. Mutates and
 * returns the same object; called once at each fetch site.
 */
export function rehydrateReportAccounts(
  json: ContentReportData,
): HydratedContentReportData {
  const byId = json.accountsById;
  if (Array.isArray(json.items)) {
    for (const it of json.items) {
      if (!it.account && it.accountId && byId) {
        it.account = byId[it.accountId] ?? null;
      } else if (it.account === undefined) {
        it.account = null;
      }
    }
  }
  return json as HydratedContentReportData;
}
