"use client";

import { useState } from "react";
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
  "Twitter",
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
  "Twitter",
  "LinkedIn",
  "TikTok",
  "Threads",
];

export function PerformanceTable({ items, brand, formats, onPostCreated }: PerformanceTableProps) {
  const hasThumbnails = items.some((item) => item.thumbnail);
  const hasPerformanceSync = items.some((item) => item.lastPerformanceSyncAt);
  const [sortKey, setSortKey] = useState<SortKey>("publishedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Add post dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPlatforms, setNewPlatforms] = useState<string[]>([]);
  const [newFormat, setNewFormat] = useState("");
  const [newLink, setNewLink] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().split("T")[0]);
  const [newViews, setNewViews] = useState("");
  const [newLikes, setNewLikes] = useState("");
  const [newComments, setNewComments] = useState("");
  const [saveResult, setSaveResult] = useState<{ success: boolean; autoFetched?: boolean; message: string } | null>(null);

  const platformOptions = brand === "matg" ? MATG_PLATFORMS : SS_PLATFORMS;

  const isYouTubeLink =
    newLink.includes("youtube.com") || newLink.includes("youtu.be");

  function openAddDialog() {
    setNewTitle("");
    setNewPlatforms([]);
    setNewFormat("");
    setNewLink("");
    setNewDate(new Date().toISOString().split("T")[0]);
    setNewViews("");
    setNewLikes("");
    setNewComments("");
    setSaveResult(null);
    setAddDialogOpen(true);
  }

  function togglePlatform(p: string) {
    setNewPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }

  async function handleAddPost() {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle,
          platform: newPlatforms,
          format: newFormat || null,
          publishedLink: newLink || null,
          publishedDate: newDate,
          brand,
          views: newViews ? parseInt(newViews, 10) : null,
          likes: newLikes ? parseInt(newLikes, 10) : null,
          comments: newComments ? parseInt(newComments, 10) : null,
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
      onPostCreated?.();
      setTimeout(() => setAddDialogOpen(false), 1500);
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
    } finally {
      setSaving(false);
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

  const sorted = [...items].sort((a, b) => {
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
      <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Content Performance</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Individual content items with detailed metrics
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openAddDialog}>
          + Add Post
        </Button>
      </div>

      {/* Add Post Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New Post</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Post title"
              />
            </div>
            <div className="space-y-2">
              <Label>Platform</Label>
              <div className="flex flex-wrap gap-2">
                {platformOptions.map((p) => (
                  <Badge
                    key={p}
                    variant={newPlatforms.includes(p) ? "default" : "outline"}
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
                <Select value={newFormat} onValueChange={(v) => setNewFormat(v || "")}>
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
                value={newLink}
                onChange={(e) => setNewLink(e.target.value)}
                placeholder="https://..."
              />
              {isYouTubeLink && (
                <p className="text-xs text-blue-600">
                  YouTube link detected — views, likes, and comments will be auto-fetched.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Published Date</Label>
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </div>

            {/* Manual metrics — hidden for YouTube links */}
            {!isYouTubeLink && (
              <div className="space-y-3 rounded-lg border border-dashed border-gray-300 p-3">
                <p className="text-xs text-muted-foreground font-medium">
                  Manual Metrics (optional)
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Views</Label>
                    <Input
                      type="number"
                      value={newViews}
                      onChange={(e) => setNewViews(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Likes</Label>
                    <Input
                      type="number"
                      value={newLikes}
                      onChange={(e) => setNewLikes(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Comments</Label>
                    <Input
                      type="number"
                      value={newComments}
                      onChange={(e) => setNewComments(e.target.value)}
                      placeholder="0"
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

            <Button
              onClick={handleAddPost}
              className="w-full"
              disabled={saving || !newTitle || !newPlatforms.length || !newDate}
            >
              {saving ? "Creating..." : isYouTubeLink ? "Create & Fetch Metrics" : "Create Post"}
            </Button>
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
                    {hasThumbnails && item.thumbnail && (
                      <img
                        src={item.thumbnail}
                        alt=""
                        className="w-20 h-12 rounded object-cover shrink-0"
                      />
                    )}
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">
                        {item.publishedLink ? (
                          <a
                            href={item.publishedLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary hover:underline transition-colors"
                          >
                            {item.title || "(Untitled)"}
                          </a>
                        ) : (
                          item.title || "(Untitled)"
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
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
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
                  {item.views?.toLocaleString() || "-"}
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
                <td colSpan={hasPerformanceSync ? 11 : 10} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  No content items found for the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
