import type { ProductionItem } from "@/types";

function escapeCsv(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function exportChannelSummaryCsv(
  items: ProductionItem[],
  brand: string,
  startDate: string,
  endDate: string
) {
  type ChannelRow = {
    brand: string;
    platform: string;
    handle: string;
    posts: number;
    views: number;
    likes: number;
    comments: number;
    clicks: number;
    leads: number;
    hubspotLeads: number;
    estimated: boolean;
  };

  const grouped = new Map<string, ChannelRow>();

  for (const item of items) {
    const acct = item.account;
    if (!acct) continue;
    const key = `${acct.brandSlug}|${acct.platform}|${acct.handle}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.posts += 1;
      existing.views += item.views ?? 0;
      existing.likes += item.likes ?? 0;
      existing.comments += item.comments ?? 0;
      existing.clicks += item.clicks ?? 0;
      existing.leads += item.leads ?? 0;
      existing.hubspotLeads += item.hubspotLeads ?? 0;
      if (item.viewsEstimated) existing.estimated = true;
    } else {
      grouped.set(key, {
        brand: acct.brandLabel,
        platform: acct.platform,
        handle: acct.displayName ?? acct.handle,
        posts: 1,
        views: item.views ?? 0,
        likes: item.likes ?? 0,
        comments: item.comments ?? 0,
        clicks: item.clicks ?? 0,
        leads: item.leads ?? 0,
        hubspotLeads: item.hubspotLeads ?? 0,
        estimated: item.viewsEstimated === true,
      });
    }
  }

  const rows = Array.from(grouped.values()).sort(
    (a, b) =>
      a.brand.localeCompare(b.brand) || a.platform.localeCompare(b.platform)
  );

  const headers = [
    "Brand",
    "Platform",
    "Handle",
    "Posts",
    "Views",
    "Views/Post",
    "Est. Views",
    "Likes",
    "Comments",
    "Clicks",
    "SS Leads",
    "HS Leads",
  ];

  const lines = [
    headers.map(escapeCsv).join(","),
    ...rows.map((r) =>
      [
        escapeCsv(r.brand),
        escapeCsv(r.platform),
        escapeCsv(r.handle),
        r.posts,
        r.views,
        r.posts > 0 ? Math.round(r.views / r.posts) : 0,
        r.estimated ? "Yes" : "No",
        r.likes,
        r.comments,
        r.clicks,
        r.leads,
        r.hubspotLeads,
      ].join(",")
    ),
  ];

  const csv = lines.join("\n");
  const filename = `channel-metrics_${brand}_${startDate}_${endDate}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
