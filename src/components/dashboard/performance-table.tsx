"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ProductionItem } from "@/types";
import { Button, buttonVariants } from "@/components/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { todayLocalISO } from "@/lib/utils/dates";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import { coverImageUrl } from "@/lib/cover-image";
import { CoverImg } from "./cover-img";
import { AccountBadge } from "@/components/ui/account-badge";
import { SourceBadge } from "@/components/ui/source-badge";
import {
  AccountPostTypePicker,
  type PickerAccount,
} from "@/components/ui/account-post-type-picker";
import type { PostType } from "@/lib/platform-field-schemas";

interface PerformanceTableProps {
  items: ProductionItem[];
  brand: string;
  formats?: string[];
  /** Accounts the create-item dialog can pick from. When absent the
   *  dialog falls back to the legacy string picker (older callers that
   *  haven't been updated yet still render). */
  accounts?: PickerAccount[];
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

function publishedSortMs(item: ProductionItem): number | null {
  if (item.publishedAt) {
    const t = new Date(item.publishedAt).getTime();
    if (!isNaN(t)) return t;
  }
  if (item.publishedDate) {
    // Parse as UTC midnight so ordering is stable regardless of viewer TZ.
    const t = new Date(`${item.publishedDate}T00:00:00Z`).getTime();
    if (!isNaN(t)) return t;
  }
  return null;
}

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

export function PerformanceTable({ items, brand, formats, accounts, onPostCreated }: PerformanceTableProps) {
  const router = useRouter();
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
  // "new"       = blank manual-entry dialog (today's behavior)
  // "from-link" = shows a paste-URL + Fetch row at the top that auto-fills
  //               all fields from the preview-link API. Edit mode leaves
  //               this null so the fetch row doesn't render.
  const [addMode, setAddMode] = useState<"new" | "from-link" | null>(null);
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const [previewWarning, setPreviewWarning] = useState<string | null>(null);

  // Form fields
  const [formTitle, setFormTitle] = useState("");
  const [formPlatforms, setFormPlatforms] = useState<string[]>([]);
  // Account + post_type for new items (new-world fields). Kept alongside
  // formPlatforms so we can still populate the legacy jsonb column for
  // backward compat until the finalize migration drops it.
  const [formAccountId, setFormAccountId] = useState<string | null>(null);
  const [formPostType, setFormPostType] = useState<PostType | null>(null);
  const [formFormat, setFormFormat] = useState("");
  const [formatPopoverOpen, setFormatPopoverOpen] = useState(false);
  const [formLink, setFormLink] = useState("");
  const [formDate, setFormDate] = useState(todayLocalISO());
  const [formClicks, setFormClicks] = useState("");
  const [formLeads, setFormLeads] = useState("");
  const [formSalesAmount, setFormSalesAmount] = useState("");
  // Set by "Add from link" fetch; sent through to POST so the new row
  // carries a real thumbnail + author without a second SC call on save.
  // The dialog doesn't expose inputs for these — they're pass-through.
  const [previewThumbnail, setPreviewThumbnail] = useState<string | null>(null);
  const [previewAuthorHandle, setPreviewAuthorHandle] = useState<string | null>(null);
  // Precise publish timestamp captured from preview-link (ISO string).
  // Forwarded to POST so same-day sort puts this row in the right spot.
  const [previewPublishedAt, setPreviewPublishedAt] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<{ success: boolean; autoFetched?: boolean; message: string } | null>(null);

  const isYouTubeLink =
    formLink.includes("youtube.com") || formLink.includes("youtu.be");

  const isEditing = editingItem !== null;

  function openAddDialog(mode: "new" | "from-link" = "new") {
    setEditingItem(null);
    setAddMode(mode);
    setFormTitle("");
    setFormPlatforms([]);
    setFormAccountId(null);
    setFormPostType(null);
    setFormFormat("");
    setFormLink("");
    setFormDate(todayLocalISO());
    setFormClicks("");
    setFormLeads("");
    setFormSalesAmount("");
    setPreviewThumbnail(null);
    setPreviewAuthorHandle(null);
    setPreviewPublishedAt(null);
    setPreviewWarning(null);
    setSaveResult(null);
    setDialogOpen(true);
  }

  async function handleFetchFromLink() {
    const url = formLink.trim();
    if (!url) return;
    setFetchingPreview(true);
    setPreviewWarning(null);
    try {
      const res = await fetch("/api/production-items/preview-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, brand }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setPreviewWarning(err.error || `Fetch failed (${res.status}).`);
        return;
      }
      const data = await res.json();
      if (data.title) setFormTitle(data.title);
      if (data.publishedDate) setFormDate(data.publishedDate);
      if (data.publishedLink) setFormLink(data.publishedLink);
      if (data.thumbnail) setPreviewThumbnail(data.thumbnail);
      if (data.authorHandle) setPreviewAuthorHandle(data.authorHandle);
      if (data.publishedAt) setPreviewPublishedAt(data.publishedAt);

      // Set account + post type, and derive the legacy platform label the
      // same way the AccountPostTypePicker's onChange does so handleSave's
      // `!formPlatforms.length` gate passes without a second user click.
      if (data.accountId) {
        setFormAccountId(data.accountId);
        setFormPostType(data.postType ?? null);
        const a = accounts?.find((x) => x.id === data.accountId);
        if (a) {
          const legacyLabel = `${a.platform}:@${a.handle}${data.postType ? `:${data.postType}` : ""}`;
          setFormPlatforms([legacyLabel]);
        }
      }

      if (data.warning) setPreviewWarning(data.warning);
    } catch (err) {
      setPreviewWarning(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingPreview(false);
    }
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
            accountId: formAccountId,
            postType: formPostType,
            format: formFormat || null,
            publishedLink: formLink || null,
            publishedDate: formDate,
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
        // Create new item. Metrics + thumbnail + authorHandle may come from
        // the Add-from-link preview; pass them through so the row lands with
        // correct data and no extra SC call on the server.
        const res = await fetch("/api/production-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: formTitle,
            platform: formPlatforms,
            accountId: formAccountId,
            postType: formPostType,
            format: formFormat || null,
            publishedLink: formLink || null,
            publishedDate: formDate,
            publishedAt: previewPublishedAt,
            brand,
            thumbnail: previewThumbnail,
            authorHandle: previewAuthorHandle,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          setSaveResult({ success: false, message: err.error || "Failed to create post" });
          return;
        }
        const data = await res.json();
        const newItemHref = data.id ? `/${brand}/content/${data.id}` : null;
        setSaveResult({
          success: true,
          autoFetched: data.autoFetched,
          message: data.autoFetched
            ? "Post created! Metrics auto-fetched from YouTube (1 credit)."
            : "Post created successfully.",
        });
        onPostCreated?.();
        setDialogOpen(false);
        if (newItemHref) {
          toast.success("Post created", {
            action: {
              label: "View post",
              onClick: () => router.push(newItemHref),
            },
          });
          router.push(newItemHref);
        }
        return;
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
    // Sorting by "Published" uses publishedAt when we have it (precise
    // platform timestamp or in-app publish moment) and falls back to
    // midnight of publishedDate for historic rows. The visible column
    // still renders as YYYY-MM-DD — this only affects sort order.
    if (sortKey === "publishedDate") {
      const aT = publishedSortMs(a);
      const bT = publishedSortMs(b);
      if (aT == null && bT == null) return 0;
      if (aT == null) return 1;
      if (bT == null) return -1;
      return sortDir === "asc" ? aT - bT : bT - aT;
    }
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
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              + Add Post
              <svg
                className="ml-1 h-3 w-3 shrink-0 opacity-60"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openAddDialog("new")}>
                Create new
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddDialog("from-link")}>
                Add from link
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Add / Edit Post Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isEditing
                ? "Edit Post"
                : addMode === "from-link"
                  ? "Add Post From Link"
                  : "Add New Post"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {addMode === "from-link" && !isEditing && (
              <div className="space-y-2 rounded-lg border border-dashed border-blue-300 bg-blue-50/50 p-3">
                <Label className="text-xs font-medium">
                  Paste published post URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={formLink}
                    onChange={(e) => setFormLink(e.target.value)}
                    placeholder="https://instagram.com/p/… or https://x.com/…/status/…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !fetchingPreview && formLink.trim()) {
                        e.preventDefault();
                        handleFetchFromLink();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleFetchFromLink}
                    disabled={fetchingPreview || !formLink.trim()}
                  >
                    {fetchingPreview ? "Fetching…" : "Fetch"}
                  </Button>
                </div>
                {previewWarning && (
                  <p className="text-xs text-amber-700">{previewWarning}</p>
                )}
                {previewThumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewThumbnail}
                    alt="Preview"
                    className="h-20 w-auto rounded border border-border object-cover"
                  />
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Post title"
              />
            </div>
            <div className="space-y-2">
              <Label>Account</Label>
              {accounts && accounts.length > 0 ? (
                <AccountPostTypePicker
                  accounts={accounts}
                  accountId={formAccountId}
                  postType={formPostType}
                  publishedLink={formLink || null}
                  brandSlug={brand}
                  onChange={({ accountId: id, postType: type }) => {
                    setFormAccountId(id);
                    setFormPostType(type);
                    // Derive a legacy platform-string for backward compat
                    // with the jsonb column — picks the account's handle
                    // plus the post type so it's unique per (account,type).
                    const a = accounts.find((x) => x.id === id);
                    if (a) {
                      const legacyLabel = `${a.platform}:@${a.handle}${type ? `:${type}` : ""}`;
                      setFormPlatforms([legacyLabel]);
                    } else {
                      setFormPlatforms([]);
                    }
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No accounts available — add one in Settings → Accounts.
                </p>
              )}
            </div>
            {formats && formats.length > 0 && (
              <div className="space-y-2">
                <Label>Format</Label>
                <Popover open={formatPopoverOpen} onOpenChange={setFormatPopoverOpen}>
                  <PopoverTrigger
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer"
                  >
                    <span className={cn(!formFormat && "text-muted-foreground")}>
                      {formFormat || "Select format..."}
                    </span>
                    <svg
                      className="ml-2 h-4 w-4 shrink-0 opacity-50"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search formats…" />
                      <CommandList>
                        <CommandEmpty>No formats found.</CommandEmpty>
                        <CommandGroup>
                          {formats.map((f) => (
                            <CommandItem
                              key={f}
                              value={f}
                              onSelect={() => {
                                setFormFormat(f);
                                setFormatPopoverOpen(false);
                              }}
                            >
                              {f}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            {addMode !== "from-link" && (
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
            )}
            <div className="space-y-2">
              <Label>Published Date</Label>
              <Input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>

            {/* Attribution metrics — only editable on an existing post.
                Views/likes/comments are never edited by hand; the
                performance-decay sweep pulls them from the platform API.
                Clicks/leads/sales have no upstream source so they stay
                manual. */}
            {isEditing && (
              <div className="space-y-3 rounded-lg border border-dashed border-gray-300 p-3">
                <p className="text-xs text-muted-foreground font-medium">
                  Attribution
                </p>
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
                    : addMode !== "from-link" && isYouTubeLink
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
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Source
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
                    {item.account ? (
                      <AccountBadge
                        account={item.account}
                        postType={item.postType}
                        variant="avatar"
                        avatarSize={28}
                      />
                    ) : (
                      item.platform?.map((p) => (
                        <span
                          key={p}
                          className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                            platformClass(p)
                          )}
                        >
                          {p}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm text-muted-foreground">{item.format || "-"}</td>
                <td className="px-3 py-2">
                  <SourceBadge sourceType={item.sourceType} />
                </td>
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
                <td colSpan={hasPerformanceSync ? 13 : 12} className="px-4 py-12 text-center text-muted-foreground text-sm">
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
