"use client";

import { useMemo, useState, useEffect } from "react";
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
import { Label } from "@/components/ui/label";

interface MergeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  primaryItem: ProductionItem;
  brand: string;
  contentId: string;
  /** When provided, skips the search step and pre-selects this item as the
   *  duplicate to merge. Used by the Potential Duplicates view. */
  preselectedSecondaryItem?: ProductionItem | null;
  onMergeComplete?: () => void;
}

export function MergeModal({
  open,
  onOpenChange,
  primaryItem,
  brand,
  contentId,
  preselectedSecondaryItem,
  onMergeComplete,
}: MergeModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [foundItems, setFoundItems] = useState<ProductionItem[]>(
    preselectedSecondaryItem ? [preselectedSecondaryItem] : []
  );
  const [selectedSecondaryId, setSelectedSecondaryId] = useState<string | null>(
    preselectedSecondaryItem?.id ?? null
  );
  const [searching, setSearching] = useState(false);
  const [merging, setMerging] = useState(false);

  // Reset form when the dialog opens, preserving any preselected item.
  useEffect(() => {
    if (!open) return;
    setSearchQuery("");
    setFoundItems(preselectedSecondaryItem ? [preselectedSecondaryItem] : []);
    setSelectedSecondaryId(preselectedSecondaryItem?.id ?? null);
    setMerging(false);
  }, [open, preselectedSecondaryItem]);

  // Search for items by title/id
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setFoundItems([]);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(
        `/api/production-items/search?brand=${brand}&q=${encodeURIComponent(searchQuery)}&limit=10&includeAll=1`
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
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Failed to merge items");
        return;
      }
      toast.success(
        `Merged successfully. The duplicate has been archived.`
      );
      onOpenChange(false);
      onMergeComplete?.();
      // Reset form
      setSearchQuery("");
      setFoundItems([]);
      setSelectedSecondaryId(null);
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

          {/* Search for duplicate — hidden when a secondary item is pre-selected */}
          {!preselectedSecondaryItem && <div className="space-y-2">
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
          </div>}

          {/* Found items */}
          {foundItems.length > 0 && (
            <div className="space-y-2">
              <Label>{preselectedSecondaryItem ? "Merging with:" : "Found items"}</Label>
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

          {/* Confirmation */}
          {selectedSecondaryItem && (
            <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-2">
              <p className="font-medium">What will happen:</p>
              <ul className="text-xs space-y-1 text-muted-foreground">
                <li>✓ Keep "{primaryItem.title}" with all your comments and history</li>
                <li>✓ Transfer view data: {(primaryItem.views || 0).toLocaleString()} + {(selectedSecondaryItem.views || 0).toLocaleString()} = {((primaryItem.views || 0) + (selectedSecondaryItem.views || 0)).toLocaleString()} views</li>
                <li>✓ Future view updates will sync automatically</li>
                <li>✓ Archive the duplicate "{selectedSecondaryItem.title}"</li>
              </ul>
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
