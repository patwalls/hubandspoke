"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, GitMerge } from "lucide-react";
import type { ProductionItem } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface MergeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  primaryItem: ProductionItem;
  brand: string;
  contentId: string;
  onMergeComplete?: () => void;
}

type MergeStrategy = "keepPrimary" | "keepSecondary" | "mergeMetrics";

export function MergeModal({
  open,
  onOpenChange,
  primaryItem,
  brand,
  contentId,
  onMergeComplete,
}: MergeModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [foundItems, setFoundItems] = useState<ProductionItem[]>([]);
  const [selectedSecondaryId, setSelectedSecondaryId] = useState<string | null>(
    null
  );
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>(
    "keepPrimary"
  );
  const [searching, setSearching] = useState(false);
  const [merging, setMerging] = useState(false);

  // Search for items by title/id
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setFoundItems([]);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(
        `/api/production-items/search?brand=${brand}&q=${encodeURIComponent(searchQuery)}&limit=10`
      );
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.items) {
        // Filter out the primary item itself
        setFoundItems(json.items.filter((item: ProductionItem) => item.id !== contentId));
      }
    } catch (err) {
      toast.error("Failed to search items");
    } finally {
      setSearching(false);
    }
  };

  const selectedSecondaryItem = useMemo(
    () =>
      selectedSecondaryId
        ? foundItems.find((item) => item.id === selectedSecondaryId)
        : null,
    [selectedSecondaryId, foundItems]
  );

  const handleMerge = async () => {
    if (!selectedSecondaryId) {
      toast.error("Please select an item to merge");
      return;
    }

    setMerging(true);
    try {
      const res = await fetch("/api/production-items/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primaryId: contentId,
          secondaryId: selectedSecondaryId,
          mergeStrategy,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Failed to merge items");
        return;
      }
      toast.success(
        `Merged with ${selectedSecondaryItem?.title || "item"}. The duplicate has been archived.`
      );
      onOpenChange(false);
      onMergeComplete?.();
      // Reset form
      setSearchQuery("");
      setFoundItems([]);
      setSelectedSecondaryId(null);
      setMergeStrategy("keepPrimary");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to merge");
    } finally {
      setMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5" />
            Merge with another item
          </DialogTitle>
          <DialogDescription>
            Find and merge a duplicate item into this one. The duplicate will be
            archived.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current item preview */}
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground mb-1">Keeping this item:</p>
            <p className="font-medium text-sm line-clamp-2">{primaryItem.title}</p>
            {primaryItem.platform && (
              <p className="text-xs text-muted-foreground mt-1">
                {(primaryItem.platform as string[])[0]}
              </p>
            )}
          </div>

          {/* Search for duplicate */}
          <div className="space-y-2">
            <Label htmlFor="search-query">Search for duplicate item</Label>
            <div className="flex gap-2">
              <Input
                id="search-query"
                placeholder="Enter item title or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
              />
              <Button
                variant="outline"
                onClick={handleSearch}
                disabled={searching || !searchQuery.trim()}
                size="sm"
              >
                <Search className="size-4" />
              </Button>
            </div>
          </div>

          {/* Found items */}
          {foundItems.length > 0 && (
            <div className="space-y-2">
              <Label>Found items</Label>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {foundItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedSecondaryId(item.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedSecondaryId === item.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    <p className="font-medium text-sm line-clamp-2">
                      {item.title}
                    </p>
                    <div className="space-y-1.5 mt-2">
                      {item.platform && (
                        <p className="text-xs font-medium text-foreground">
                          {(item.platform as string[])[0]}
                        </p>
                      )}
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        {item.views && <span>{item.views.toLocaleString()} views</span>}
                        {item.publishedDate && (
                          <span>{new Date(item.publishedDate).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Merge strategy */}
          {selectedSecondaryItem && (
            <div className="space-y-2">
              <Label htmlFor="merge-strategy">Merge strategy</Label>
              <Select value={mergeStrategy} onValueChange={(v) => setMergeStrategy(v as MergeStrategy)}>
                <SelectTrigger id="merge-strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keepPrimary">
                    <span className="font-medium">Keep this item's data</span>
                    <span className="text-xs text-muted-foreground block">
                      Archive the selected item, keep all data from this one
                    </span>
                  </SelectItem>
                  <SelectItem value="keepSecondary">
                    <span className="font-medium">Use duplicate's data</span>
                    <span className="text-xs text-muted-foreground block">
                      Use the selected item's data instead, archive this one
                    </span>
                  </SelectItem>
                  <SelectItem value="mergeMetrics">
                    <span className="font-medium">Combine view counts</span>
                    <span className="text-xs text-muted-foreground block">
                      Keep this item's data but sum view counts from both
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Confirmation */}
          {selectedSecondaryItem && (
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <p className="font-medium mb-2">Preview:</p>
              <p className="text-xs">
                {mergeStrategy === "keepPrimary"
                  ? `Keeping "${primaryItem.title}". Archiving "${selectedSecondaryItem.title}".`
                  : mergeStrategy === "keepSecondary"
                  ? `Using data from "${selectedSecondaryItem.title}". Archiving the current item.`
                  : `Keeping "${primaryItem.title}". Combining view counts: ${(primaryItem.views || 0).toLocaleString()} + ${(selectedSecondaryItem.views || 0).toLocaleString()} views.`}
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={merging}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMerge}
              disabled={!selectedSecondaryId || merging}
            >
              {merging ? "Merging..." : "Merge"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
