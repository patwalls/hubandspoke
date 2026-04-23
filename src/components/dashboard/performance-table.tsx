"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProductionItem } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { todayLocalISO } from "@/lib/utils/dates";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import { coverImageUrl } from "@/lib/cover-image";
import { CoverImg } from "./cover-img";

interface PerformanceTableProps {
  items: ProductionItem[];
  brand: string;
  formats?: string[];
  onPostCreated?: () => void;
}

type SortKey =
  | "title"
  | "publishedDate"
  | "views"
  | "likes"
  | "comments"
  | "clicks"
  | "leads"
  | "salesAmount";

function getFreshness(item: ProductionItem): {
  color: string;
  label: string;
  dotClass: string;
} {
  if (!item.lastPerformanceSyncAt) {
    return { color: "text-red-500", label: "Never", dotClass: "bg-red-400" };
  }
  const elapsed = Date.now() - new Date(item.lastPerformanceSyncAt).getTime();
  const hours = elapsed / (1000 * 60 * 60);
  const days = hours / 24;

  if (hours < 1) return { color: "text-green-600", label: "Just now", dotClass: "bg-green-400" };
  if (hours < 6) return { color: "text-green-600", label: `${Math.floor(hours)}h ago`, dotClass: "bg-green-400" };
  if (hours < 24) return { color: "text-green-600", label: `${Math.floor(hours)}h ago`, dotClass: "bg-green-400" };
  if (days < 3) return { color: "text-yellow-600", label: `${Math.floor(days)}d ago`, dotClass: "bg-yellow-400" };
  if (days < 7) return { color: "text-yellow-600", label: `${Math.floor(days)}d ago`, dotClass: "bg-yellow-400" };
  return { color: "text-muted-foreground", label: `${Math.floor(days)}d ago`, dotClass: "bg-gray-400" };
}

const SS_PLATFORMS = [
  "YouTube (SS)",
  "YouTube (SS Build)",
  "YouTube Shorts",
  "YouTube Community",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "X (Starter Story)",
  "X (Pat Walls)",
  "LinkedIn",
  "TikTok",
  "Threads",
  "Newsletter",
];

const MATG_PLATFORMS = [
  "YouTube",
  "YouTube Shorts",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "X",
  "LinkedIn",
  "TikTok",
  "Threads",
];

export function PerformanceTable({ items, brand, formats, onPostCreated }: PerformanceTableProps) {
  const hasThumbnails = items.some((item) => coverImageUrl(item));
  const hasPerformanceSync = items.some((item) => item.lastPerformanceSyncAt);
  const [sortKey, setSortKey] = useState<SortKey>("publishedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");

  // Dialog state — shared for add and edit
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ProductionItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Form fields
  const [formTitle, setFormTitle] = useState("");
  const [formPlatforms, setFormPlatforms] = useState<string[]>([]);
  const [formFormat, setFormFormat] = useState("");
  const [formLink, setFormLink] = useState("");
  const [formDate, setFormDate] = useState(todayLocalISO());
  const [formViews, setFormViews] = useState("");
  const [formLikes, setFormLikes] = useState("");
  const [formComments, setFormComments] = useState("");
  const [formClicks, setFormClicks] = useState("");
  const [formLeads, setFormLeads] = useState("");
  const [formSalesAmount, setFormSalesAmount] = useState("");
  const [saveResult, setSaveResult] = useState<{ success: boolean; autoFetched?: boolean; message: string } | null>(null);

  const platformOptions = brand === "matg" ? MATG_PLATFORMS : SS_PLATFORMS;

  const isYouTubeLink =
    formLink.includes("youtube.com") || formLink.includes("youtu.be");

  const isEditing = editingItem !== null;

  function openAddDialog() {
    setEditingItem(null);
    setFormTitle("");
    setFormPlatforms([]);
    setFormFormat("");
    setFormLink("");
    setFormDate(todayLocalISO());
    setFormViews("");
    setFormLikes("");
    setFormComments("");
    setFormClicks("");
    setFormLeads("");
    setFormSalesAmount("");
    setSaveResult(null);
    setDialogOpen(true);
  }

  function togglePlatform(p: string) {
    setFormPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      if (isEditing) {
        // Update existing item
        const res = await fetch("/api/production-items", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingItem!.id,
            title: formTitle,
            platform: formPlatforms,
            format: formFormat || null,
            publishedLink: formLink || null,
            publishedDate: formDate,
            views: formViews ? parseInt(formViews, 10) : null,
            likes: formLikes ? parseInt(formLikes, 10) : null,
            comments: formComments ? parseInt(formComments, 10) : null,
            clicks: formClicks ? parseInt(formClicks, 10) : null,
            leads: formLeads ? parseInt(formLeads, 10) : null,
            salesAmount: formSalesAmount || null,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          setSaveResult({ success: false, message: err.error || "Failed to update post" });
          return;
        }
        setSaveResult({ success: true, message: "Post updated successfully." });
      } else {
        // Create new item
        const res = await fetch("/api/production-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: formTitle,
            platform: formPlatforms,
            format: formFormat || null,
            publishedLink: formLink || null,
            publishedDate: formDate,
            brand,
            views: formViews ? parseInt(formViews, 10) : null,
            likes: formLikes ? parseInt(formLikes, 10) : null,
            comments: formComments ? parseInt(formComments, 10) : null,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          setSaveResult({ success: false, message: err.error || "Failed to create post" });
          return;
        }
        const data = await res.json();
        setSaveResult({
          success: true,
          autoFetched: data.autoFetched,
          message: data.autoFetched
            ? "Post created! Metrics auto-fetched from YouTube (1 credit)."
            : "Post created successfully.",
        });
      }
      onPostCreated?.();
      setTimeout(() => setDialogOpen(false), 1200);
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingItem) return;
    if (!confirm("Delete this post? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/production-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingItem.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSaveResult({ success: false, message: err.error || "Failed to delete post" });
        return;
      }
      setSaveResult({ success: true, message: "Post deleted." });
      onPostCreated?.();
      setTimeout(() => setDialogOpen(false), 800);
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
    } finally {
      setDeleting(false);
    }
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const query = search.trim().toLowerCase();
  const filtered = query
    ? items.filter((item) => {
        const title = item.title?.toLowerCase() ?? "";
        const format = item.format?.toLowerCase() ?? "";
        const platforms = item.platform?.join(" ").toLowerCase() ?? "";
        return (
          title.includes(query) ||
          format.includes(query) ||
          platforms.includes(query)
        );
      })
    : items;

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === "asc"
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  function SortHeader({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) {
    const isActive = sortKey === sortKeyName;
    return (
      <th
        className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap transition-colors"
        onClick={() => handleSort(sortKeyName)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive && (
            <span className="text-foreground">{sortDir === "asc" ? "\u2191" : "\u2193"}</span>
          )}
        </span>
      </th>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Content Performance</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Individual content items with detailed metrics
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, format, platform…"
            className="h-8 w-48 sm:w-64 text-xs"
          />
          <Button variant="outline" size="sm" onClick={openAddDialog}>
            + Add Post
          </Button>
        </div>
      </div>

      {/* Add / Edit Post Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Post" : "Add New Post"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Post title"
              />
            </div>
            <div className="space-y-2">
              <Label>Platform</Label>
              <div className="flex flex-wrap gap-2">
                {platformOptions.map((p) => (
                  <Badge
                    key={p}
                    variant={formPlatforms.includes(p) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => togglePlatform(p)}
                  >
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
            {formats && formats.length > 0 && (
              <div className="space-y-2">
                <Label>Format</Label>
                <Select value={formFormat} onValueChange={(v) => setFormFormat(v || "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select format..." />
                  </SelectTrigger>
                  <SelectContent>
                    {formats.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Published Link</Label>
              <Input
                value={formLink}
                onChange={(e) => setFormLink(e.target.value)}
                placeholder="https://..."
              />
              {!isEditing && isYouTubeLink && (
                <p className="text-xs text-blue-600">
                  YouTube link detected — views, likes, and comments will be auto-fetched.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Published Date</Label>
              <Input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>

            {/* Metrics section */}
            {(isEditing || !isYouTubeLink) && (
              <div className="space-y-3 rounded-lg border border-dashed border-gray-300 p-3">
                <p className="text-xs text-muted-foreground font-medium">
                  Metrics {!isEditing && "(optional)"}
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Views</Label>
                    <Input
                      type="number"
                      value={formViews}
                      onChange={(e) => setFormViews(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Likes</Label>
                    <Input
                      type="number"
                      value={formLikes}
                      onChange={(e) => setFormLikes(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Comments</Label>
                    <Input
                      type="number"
                      value={formComments}
                      onChange={(e) => setFormComments(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Clicks</Label>
                    <Input
                      type="number"
                      value={formClicks}
                      onChange={(e) => setFormClicks(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Leads</Label>
                    <Input
                      type="number"
                      value={formLeads}
                      onChange={(e) => setFormLeads(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Sales $</Label>
                    <Input
                      type="number"
                      value={formSalesAmount}
                      onChange={(e) => setFormSalesAmount(e.target.value)}
                      placeholder="0"
                      step="0.01"
                    />
                  </div>
                </div>
              </div>
            )}

            {saveResult && (
              <div
                className={`text-sm rounded-lg px-3 py-2 ${
                  saveResult.success
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-red-50 text-red-700 border border-red-200"
                }`}
              >
                {saveResult.message}
              </div>
            )}

            <div className="flex gap-2">
              {isEditing && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={saving || deleting}
                  className="mr-auto"
                >
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
              )}
              <Button
                onClick={handleSave}
                className={isEditing ? "flex-1" : "w-full"}
                disabled={saving || deleting || !formTitle || !formPlatforms.length || !formDate}
              >
                {saving
                  ? (isEditing ? "Saving..." : "Creating...")
                  : isEditing
                    ? "Save Changes"
                    : isYouTubeLink
                      ? "Create & Fetch Metrics"
                      : "Create Post"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <SortHeader label="Title" sortKeyName="title" />
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Platform
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Format
              </th>
              <SortHeader label="Published" sortKeyName="publishedDate" />
              {hasPerformanceSync && (
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Synced
                </th>
              )}
              <SortHeader label="Views" sortKeyName="views" />
              <SortHeader label="Likes" sortKeyName="likes" />
              <SortHeader label="Comments" sortKeyName="comments" />
              <SortHeader label="Clicks" sortKeyName="clicks" />
              <SortHeader label="Leads" sortKeyName="leads" />
              <SortHeader label="Sales $" sortKeyName="salesAmount" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border/50 hover:bg-accent/30 transition-colors"
              >
                <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                  <div className="flex items-center gap-3">
                    {hasThumbnails && (
                      <CoverImg
                        src={coverImageUrl(item)}
                        className="h-12 w-auto rounded shrink-0"
                      />
                    )}
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate inline-flex items-center gap-1.5">
                        <Link
                          href={`/${brand}/content/${item.id}`}
                          className="hover:text-primary hover:underline transition-colors truncate"
                        >
                          {item.title || "(Untitled)"}
                        </Link>
                        {item.publishedLink && (
                          <a
                            href={item.publishedLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground shrink-0"
                            title="Open published post"
                            aria-label="Open published post"
                          >
                            ↗
                          </a>
                        )}
                      </span>
                      {item.utmCampaign && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {item.utmCampaign}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {item.platform?.map((p) => (
                      <span
                        key={p}
                        className={cn(
                          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                          platformClass(p)
                        )}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm text-muted-foreground">{item.format || "-"}</td>
                <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                  {item.publishedDate || "-"}
                </td>
                {hasPerformanceSync && (() => {
                  const freshness = getFreshness(item);
                  return (
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] ${freshness.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${freshness.dotClass}`} />
                        {freshness.label}
                      </span>
                    </td>
                  );
                })()}
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.views != null ? (
                    <span title={item.viewsEstimated ? "Estimated from likes" : undefined}>
                      {item.viewsEstimated ? "~" : ""}{item.views.toLocaleString()}
                    </span>
                  ) : "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.likes?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.comments?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.clicks?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.leads || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.salesAmount ? `$${item.salesAmount.toLocaleString()}` : "-"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={hasPerformanceSync ? 12 : 11} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  {query
                    ? `No content items match “${search}”.`
                    : "No content items found for the selected filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
