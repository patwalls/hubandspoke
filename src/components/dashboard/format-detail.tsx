"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { BackLink } from "./back-link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { statusClassWithPalette } from "@/lib/badge-colors";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { coverImageUrl } from "@/lib/cover-image";
import { CoverImg } from "./cover-img";
import { Button, buttonVariants } from "@/components/ui/button";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { AccountBadge } from "@/components/ui/account-badge";
import type { PickerAccount } from "@/components/ui/account-post-type-picker";
import { PlatformIcon } from "@/components/ui/platform-icon";
import {
  PLATFORM_META,
  POST_TYPE_SHORT_LABEL,
  toPlatform,
  type Platform,
} from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";
import { applyStarterTemplate } from "@/lib/format-skill";
import { recordVisit } from "@/lib/hooks/use-recent-items";
import { FormatStatusBadge } from "./format-status-badge";
import type { FormatProvenStatus } from "@/lib/services/format-proven-shared";
import {
  PropertyRow,
  PropertyRowGroup,
  PropertyRowSolo,
  PROPERTY_INPUT_CLASS,
  PROPERTY_TRIGGER_CLASS,
} from "./property-row";

interface AccountChannelSelection {
  accountId: string;
  postType: PostType | null;
}

interface AccountChannelWithAccount extends AccountChannelSelection {
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    brandSlug: string;
    brandLabel: string;
  };
}

function selectionKey(s: { accountId: string; postType: PostType | null }): string {
  return `${s.accountId}|${s.postType ?? ""}`;
}

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

interface FormatRow {
  id: string;
  name: string;
  brand: string;
  accountChannels: AccountChannelWithAccount[];
  viewThreshold: number | null;
  editor: string | null;
  instructions: string | null;
  parentFormatId: string | null;
  isClippableFormat: boolean;
  isCanvaFormat: boolean;
  labelsAsOriginal: boolean;
  clipTargetPlatform: string[] | null;
  clipTargetPostType: string | null;
  clipAspectRatio: string | null;
  descriptLayoutPackId: string | null;
  proven?: boolean;
  provenStatus?: FormatProvenStatus | null;
}

interface DescriptLayoutPack {
  id: string;
  name: string;
  descriptId: string;
  pageUrl: string | null;
}

interface ContentItem {
  id: string;
  title: string | null;
  platform: string[] | null;
  publishedDate: string | null;
  publishedLink: string | null;
  thumbnail: string | null;
  posterUrl: string | null;
  mediaUrl: string | null;
  mediaContentType: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  leads: number | null;
  status: string | null;
  viewsEstimated: boolean;
  descriptProjectUrl: string | null;
  descriptCompositionUrl: string | null;
  accountId: string | null;
  postType: PostType | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    brandSlug: string;
    brandLabel: string;
  } | null;
}

interface DetailMetrics {
  totalPosts: number;
  totalViews: number;
  avgViews: number;
  lastPublished: string | null;
}

interface DetailResponse {
  format: FormatRow;
  children: FormatRow[];
  ancestors: { id: string; name: string }[];
  items: ContentItem[];
  metrics: DetailMetrics;
}

interface FormatDetailProps {
  brand: string;
  formatId: string;
  /** Per-brand status palette — Map<status name, color token>. Used to
   *  color the status chip on each item in the format's content list. */
  statusPalette?: ReadonlyMap<string, string>;
}

function ContentSortHeader<K extends string>({
  label,
  sortKeyName,
  sort,
  onToggle,
  align = "left",
  className,
}: {
  label: string;
  sortKeyName: K;
  sort: { key: K; dir: "asc" | "desc" };
  onToggle: (k: K) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === sortKeyName;
  const arrow = !active ? "" : sort.dir === "asc" ? "↑" : "↓";
  return (
    <th
      className={cn(
        "px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKeyName)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer",
          align === "right" && "justify-end",
          active && "text-foreground"
        )}
      >
        <span>{label}</span>
        <span className={cn("inline-block w-2 text-[10px]", !active && "opacity-0")} aria-hidden>
          {arrow}
        </span>
      </button>
    </th>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const FORMAT_TAB_VALUES = ["details", "derivatives", "content"] as const;
type FormatTab = (typeof FORMAT_TAB_VALUES)[number];

export function FormatDetail({ brand, formatId, statusPalette }: FormatDetailProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: FormatTab = FORMAT_TAB_VALUES.includes(tabParam as FormatTab)
    ? (tabParam as FormatTab)
    : "details";
  const setActiveTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "details") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [allFormats, setAllFormats] = useState<FormatRow[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [accounts, setAccounts] = useState<PickerAccount[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [selections, setSelections] = useState<AccountChannelSelection[]>([]);
  const [viewThreshold, setViewThreshold] = useState("");
  const [editor, setEditor] = useState("");
  const [instructions, setInstructions] = useState("");
  const [preTemplateInstructions, setPreTemplateInstructions] = useState<string | null>(null);
  const [parentFormatId, setParentFormatId] = useState<string | null>(null);
  const [isClippableFormat, setIsClippableFormat] = useState(false);
  const [isCanvaFormat, setIsCanvaFormat] = useState(false);
  const [labelsAsOriginal, setLabelsAsOriginal] = useState(false);
  const [clipTargetPostType, setClipTargetPostType] = useState<string>("");
  const [clipTargetPlatform, setClipTargetPlatform] = useState<string[]>([]);
  const [clipAspectRatio, setClipAspectRatio] = useState<string>("");
  const [descriptLayoutPackId, setDescriptLayoutPackId] = useState<string | null>(null);
  const [layoutPacks, setLayoutPacks] = useState<DescriptLayoutPack[]>([]);
  const [addPackOpen, setAddPackOpen] = useState(false);
  const [newPackName, setNewPackName] = useState("");
  const [newPackUrl, setNewPackUrl] = useState("");
  const [addPackBusy, setAddPackBusy] = useState(false);
  const [addPackError, setAddPackError] = useState<string | null>(null);

  const [editorPopoverOpen, setEditorPopoverOpen] = useState(false);
  const [channelsPopoverOpen, setChannelsPopoverOpen] = useState(false);
  const [parentPopoverOpen, setParentPopoverOpen] = useState(false);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Update-format-on-row dialog state. Lets the editor reassign a content
  // row's format from this listing — used to fix mis-categorized posts in
  // bulk without leaving the format detail page.
  const [updateFormatItemId, setUpdateFormatItemId] = useState<string | null>(
    null,
  );
  const [updateFormatSearch, setUpdateFormatSearch] = useState("");
  const [updateFormatSaving, setUpdateFormatSaving] = useState(false);

  // Bulk-clear selection state for the All content table. Used to fix
  // mass-misapplied formats — tick the rows that don't belong here,
  // hit "Clear format" once, every selected item's format becomes null.
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkClearing, setBulkClearing] = useState(false);

  // New-derivative dialog state.
  const [addChildOpen, setAddChildOpen] = useState(false);
  const [childName, setChildName] = useState("");
  const [childSelections, setChildSelections] = useState<AccountChannelSelection[]>([]);
  const [childViewThreshold, setChildViewThreshold] = useState("");
  const [childEditor, setChildEditor] = useState("");
  const [childInstructions, setChildInstructions] = useState("");
  const [childEditorOpen, setChildEditorOpen] = useState(false);
  const [childChannelsOpen, setChildChannelsOpen] = useState(false);
  const [savingChild, setSavingChild] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);

  function openAddChild() {
    setChildName("");
    setChildSelections([]);
    setChildViewThreshold("");
    setChildEditor("");
    setChildInstructions("");
    setChildError(null);
    setAddChildOpen(true);
  }

  function toggleChildSelection(s: AccountChannelSelection) {
    setChildSelections((prev) => {
      const k = selectionKey(s);
      const exists = prev.find((p) => selectionKey(p) === k);
      return exists ? prev.filter((p) => selectionKey(p) !== k) : [...prev, s];
    });
  }

  async function submitAddChild() {
    if (!childName.trim()) {
      setChildError("Name is required");
      return;
    }
    setSavingChild(true);
    setChildError(null);
    try {
      const res = await fetch("/api/formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: childName.trim(),
          brand,
          accountChannels: childSelections,
          viewThreshold: childViewThreshold ? parseInt(childViewThreshold, 10) : null,
          editor: childEditor || null,
          instructions: childInstructions || null,
          parentFormatId: formatId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setChildError(body.error || `HTTP ${res.status}`);
        return;
      }
      setAddChildOpen(false);
      await load();
    } catch (err) {
      setChildError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSavingChild(false);
    }
  }

  const [clipItem, setClipItem] = useState<ContentItem | null>(null);
  const [clipTargetId, setClipTargetId] = useState<string>("");
  const [clipLoading, setClipLoading] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const [clipResult, setClipResult] = useState<
    { jobId: string; projectUrl: string; prompt: string; targetFormatName: string; window: { startSec: number; endSec: number } } | null
  >(null);

  type ContentSortKey = "title" | "account" | "publishedDate" | "views" | "likes" | "leads";
  // All-content tab sort lives in the URL so sort order is shareable and
  // survives reload. Coexists with the manual `?tab=` handler above —
  // both write through `router.replace` and preserve unrelated keys.
  const contentSortState = useUrlState({
    contentSortKey: { default: "views" },
    contentSortDir: { default: "desc" },
  });
  const contentSort = {
    key: contentSortState.values.contentSortKey as ContentSortKey,
    dir: (contentSortState.values.contentSortDir === "asc"
      ? "asc"
      : "desc") as "asc" | "desc",
  };
  function toggleContentSort(key: ContentSortKey) {
    if (contentSort.key === key) {
      contentSortState.set(
        "contentSortDir",
        contentSort.dir === "asc" ? "desc" : "asc",
      );
    } else {
      contentSortState.setMany({
        contentSortKey: key,
        contentSortDir: key === "title" || key === "account" ? "asc" : "desc",
      });
    }
  }

  function openClipModal(item: ContentItem) {
    setClipItem(item);
    setClipTargetId("");
    setClipError(null);
    setClipResult(null);
    setClipLoading(false);
  }

  function closeClipModal() {
    setClipItem(null);
    setClipTargetId("");
    setClipError(null);
    setClipResult(null);
    setClipLoading(false);
  }

  async function submitClip() {
    if (!clipItem || !clipTargetId) return;
    setClipLoading(true);
    setClipError(null);
    setClipResult(null);
    try {
      const res = await fetch("/api/descript/clip-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: clipItem.id,
          targetFormatId: clipTargetId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setClipError(json.error || `HTTP ${res.status}`);
      } else {
        setClipResult(json);
      }
    } catch (err) {
      setClipError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setClipLoading(false);
    }
  }

  const descriptClipTargets = (data?.children ?? []).filter(
    (f) => f.id !== formatId
  );

  const [descriptItem, setDescriptItem] = useState<ContentItem | null>(null);
  const [descriptMode, setDescriptMode] = useState<"upload" | "url">("upload");
  const [descriptUrl, setDescriptUrl] = useState("");
  const [descriptFile, setDescriptFile] = useState<File | null>(null);
  const [descriptStage, setDescriptStage] = useState<
    "idle" | "creating" | "uploading" | "done"
  >("idle");
  const [descriptProgress, setDescriptProgress] = useState(0);
  const [descriptError, setDescriptError] = useState<string | null>(null);
  const [descriptResult, setDescriptResult] = useState<
    { projectUrl: string } | null
  >(null);

  function openDescriptModal(item: ContentItem) {
    setDescriptItem(item);
    setDescriptMode("upload");
    setDescriptUrl(item.publishedLink || "");
    setDescriptFile(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
    setDescriptError(null);
    setDescriptResult(null);
  }

  function closeDescriptModal() {
    setDescriptItem(null);
    setDescriptFile(null);
    setDescriptUrl("");
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
    setS3KeyForRetry(null);
  }

  async function submitDescriptUrl() {
    if (!descriptItem || !descriptUrl.trim()) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    try {
      const res = await fetch("/api/descript/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "url",
          url: descriptUrl.trim(),
          projectName: descriptItem.title || "Imported video",
          itemId: descriptItem.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDescriptError(json.error || `HTTP ${res.status}`);
        setDescriptStage("idle");
      } else {
        setDescriptResult({ projectUrl: json.projectUrl });
        setDescriptStage("done");
        load();
      }
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Request failed");
      setDescriptStage("idle");
    }
  }

  // After S3 upload succeeds we keep the key around so a Descript-step
  // failure can be retried without re-uploading the file.
  const [s3KeyForRetry, setS3KeyForRetry] = useState<string | null>(null);

  async function callDescriptForS3Key(key: string, projectName: string, itemId: string) {
    const res = await fetch("/api/descript/create-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "s3", s3Key: key, projectName, itemId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.projectUrl as string;
  }

  async function retryDescriptImport() {
    if (!descriptItem || !s3KeyForRetry) return;
    setDescriptError(null);
    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        s3KeyForRetry,
        descriptItem.title || "Imported video",
        descriptItem.id
      );
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Descript import failed");
      setDescriptStage("idle");
    }
  }

  async function submitDescriptUpload() {
    if (!descriptItem || !descriptFile) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptProgress(0);
    setS3KeyForRetry(null);

    // Step 1: ask our server for a presigned PUT URL into our S3 bucket.
    let uploadUrl: string, key: string, bucket: string;
    try {
      const res = await fetch("/api/uploads/s3-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: descriptItem.id,
          fileName: descriptFile.name,
          contentType: descriptFile.type || "video/mp4",
          fileSize: descriptFile.size,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDescriptError(json.error || `HTTP ${res.status}`);
        setDescriptStage("idle");
        return;
      }
      uploadUrl = json.uploadUrl;
      key = json.key;
      bucket = json.bucket;
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Request failed");
      setDescriptStage("idle");
      return;
    }

    // Step 2: PUT the file directly from the browser to S3.
    setDescriptStage("uploading");
    const contentType = descriptFile.type || "video/mp4";
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setDescriptProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        });
        xhr.addEventListener("error", () => reject(new Error("Upload failed (network)")));
        xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
        xhr.open("PUT", uploadUrl);
        // Must match the ContentType signed into the URL.
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.send(descriptFile);
      });
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Upload failed");
      setDescriptStage("idle");
      return;
    }

    // Step 3: confirm to our server that the upload landed (persists key on the item).
    try {
      const res = await fetch("/api/uploads/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: descriptItem.id,
          key,
          bucket,
          contentType,
          fileSize: descriptFile.size,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setDescriptError(json.error || `Confirm failed: HTTP ${res.status}`);
        setDescriptStage("idle");
        return;
      }
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Confirm failed");
      setDescriptStage("idle");
      return;
    }

    // Stash the key in case the Descript step fails — retry won't re-upload.
    setS3KeyForRetry(key);

    // Step 4: kick off Descript URL-mode import using a presigned GET URL.
    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        key,
        descriptItem.title || "Imported video",
        descriptItem.id
      );
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Descript import failed");
      setDescriptStage("idle");
    }
  }

  function applyFormat(f: FormatRow) {
    setName(f.name);
    setSelections(
      (f.accountChannels || []).map((c) => ({
        accountId: c.accountId,
        postType: c.postType,
      }))
    );
    setViewThreshold(f.viewThreshold != null ? String(f.viewThreshold) : "");
    setEditor(f.editor || "");
    setInstructions(f.instructions || "");
    setParentFormatId(f.parentFormatId ?? null);
    setIsClippableFormat(f.isClippableFormat ?? false);
    setClipTargetPostType(f.clipTargetPostType ?? "");
    setClipTargetPlatform(
      Array.isArray(f.clipTargetPlatform) ? f.clipTargetPlatform : [],
    );
    setClipAspectRatio(f.clipAspectRatio ?? "");
    setDescriptLayoutPackId(f.descriptLayoutPackId ?? null);
    setIsCanvaFormat(f.isCanvaFormat ?? false);
    setLabelsAsOriginal(f.labelsAsOriginal ?? false);
  }

  const loadLayoutPacks = useCallback(async () => {
    try {
      const res = await fetch("/api/descript-layout-packs");
      if (!res.ok) return;
      const json = (await res.json()) as { packs?: DescriptLayoutPack[] };
      setLayoutPacks(json.packs ?? []);
    } catch {
      // Non-fatal — the dropdown just shows "None" until a reload.
    }
  }, []);

  useEffect(() => {
    void loadLayoutPacks();
  }, [loadLayoutPacks]);

  async function addLayoutPack() {
    if (!newPackName.trim() || !newPackUrl.trim() || addPackBusy) return;
    setAddPackBusy(true);
    setAddPackError(null);
    try {
      const res = await fetch("/api/descript-layout-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newPackName.trim(), url: newPackUrl.trim() }),
      });
      const json = (await res.json()) as {
        pack?: DescriptLayoutPack;
        error?: string;
      };
      if (!res.ok || !json.pack) {
        setAddPackError(json.error || "Failed to register pack");
        return;
      }
      await loadLayoutPacks();
      // Select the new pack on this format immediately — registering from
      // here means "use it here".
      setDescriptLayoutPackId(json.pack.id);
      void persistField({ descriptLayoutPackId: json.pack.id });
      setAddPackOpen(false);
      setNewPackName("");
      setNewPackUrl("");
    } finally {
      setAddPackBusy(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, listRes] = await Promise.all([
        fetch(`/api/formats/${formatId}`),
        fetch(`/api/formats?brand=${brand}`),
      ]);
      if (!detailRes.ok) {
        setData(null);
        return;
      }
      const json = (await detailRes.json()) as DetailResponse;
      setData(json);
      applyFormat(json.format);
      if (listRes.ok) {
        const list = await listRes.json();
        setAllFormats(list);
      }
    } catch (err) {
      console.error("Failed to load format detail:", err);
    } finally {
      setLoading(false);
    }
  }, [brand, formatId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const f = data?.format;
    if (!f) return;
    recordVisit({
      kind: "format",
      id: formatId,
      title: f.name,
      subtitle:
        (f.accountChannels ?? [])
          .map((c) => `@${c.account.handle}`)
          .join(" · ") || undefined,
      brand,
      href: `/${brand}/formats/${formatId}`,
    });
  }, [brand, formatId, data?.format]);

  useEffect(() => {
    async function loadAssignable() {
      try {
        const res = await fetch("/api/users/assignable");
        if (res.ok) {
          const json = await res.json();
          setAssignableUsers(json.users || []);
        }
      } catch (err) {
        console.error("Failed to fetch assignable users:", err);
      }
    }
    loadAssignable();
  }, []);

  useEffect(() => {
    async function loadAccounts() {
      try {
        const res = await fetch(`/api/accounts?brand=${brand}`);
        if (res.ok) {
          const json = (await res.json()) as { accounts: PickerAccount[] };
          setAccounts(json.accounts);
        }
      } catch (err) {
        console.error("Failed to fetch accounts:", err);
      }
    }
    loadAccounts();
  }, [brand]);

  function toggleSelection(s: AccountChannelSelection) {
    setSelections((prev) => {
      const k = selectionKey(s);
      const exists = prev.find((p) => selectionKey(p) === k);
      const next = exists
        ? prev.filter((p) => selectionKey(p) !== k)
        : [...prev, s];
      void persistField({ accountChannels: next });
      return next;
    });
  }

  async function setChildParent(childId: string, newParentId: string | null) {
    const child = allFormats.find((f) => f.id === childId);
    if (!child) return;
    await fetch("/api/formats", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: child.id,
        name: child.name,
        accountChannels: (child.accountChannels || []).map((c) => ({
          accountId: c.accountId,
          postType: c.postType,
        })),
        viewThreshold: child.viewThreshold ?? null,
        editor: child.editor ?? null,
        instructions: child.instructions ?? null,
        parentFormatId: newParentId,
      }),
    });
    await load();
  }

  // Autosave: send one-field patches to PUT /api/formats. The server-side
  // partial-patch logic ignores missing keys, so this never clobbers
  // untouched columns. Mirrors content-detail's `persistField` pattern so
  // the two detail pages feel identical.
  const persistField = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setSaveState({ kind: "saving" });
      try {
        const res = await fetch("/api/formats", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: formatId, ...patch }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          const msg = json.error || `Save failed (HTTP ${res.status}).`;
          console.error("[format autosave] failed:", res.status, json);
          setSaveState({ kind: "error", message: msg });
          return false;
        }
        setSaveState({ kind: "saved" });
        // Name rename cascades to productionItems.format on the server, so
        // a rename invalidates the items list. Reload to reflect the
        // changed strings. Other patches don't affect joined data.
        if ("name" in patch || "accountChannels" in patch) {
          await load();
        }
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Save failed";
        console.error("[format autosave] error:", err);
        setSaveState({ kind: "error", message: msg });
        return false;
      }
    },
    [formatId, load]
  );

  // Renaming a format rewrites every production_item.format + clip_idea
  // target that links to it by name (server cascade, brand-scoped). Show the
  // blast radius before committing so a rename is never a silent surprise.
  // Skip the prompt when nothing references the format yet (fresh format / typo
  // fix) — confirming a 0-impact rename is just friction.
  const confirmAndRename = useCallback(
    async (next: string) => {
      const savedName = data?.format.name ?? "";
      let impact: { productionItems: number; clipIdeas: number } | null = null;
      try {
        const res = await fetch(`/api/formats/rename-impact?id=${formatId}`);
        if (res.ok) impact = await res.json();
      } catch {
        // Non-fatal: fall back to a generic confirm below.
      }

      if (impact && impact.productionItems === 0 && impact.clipIdeas === 0) {
        await persistField({ name: next });
        return;
      }

      const plural = (n: number, word: string) =>
        `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
      const detail = impact
        ? `\n\nThis also updates ${plural(
            impact.productionItems,
            "production item",
          )} and ${plural(
            impact.clipIdeas,
            "clip idea",
          )} that reference this format by name.`
        : "";

      if (!window.confirm(`Rename "${savedName}" → "${next}"?${detail}`)) {
        setName(savedName);
        return;
      }
      await persistField({ name: next });
    },
    [formatId, data, persistField],
  );

  async function confirmDelete() {
    setDeleting(true);
    setDeleteConfirmOpen(false);
    try {
      const res = await fetch("/api/formats", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: formatId }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Unknown error" }));
        toast.error(`Delete failed: ${error}`);
        setDeleting(false);
        return;
      }
      router.push(`/${brand}/formats`);
    } catch (err) {
      console.error("Delete failed:", err);
      setDeleting(false);
    }
  }

  const filteredFormatsForUpdate = useMemo(() => {
    const q = updateFormatSearch.trim().toLowerCase();
    return allFormats
      .filter((f) => f.id !== formatId)
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allFormats, formatId, updateFormatSearch]);

  // Bulk-clear the format on every checked row in the All content table.
  // Hits PUT /api/production-items with `format: null` once per item in
  // parallel; reports the count in the toast and surfaces failures
  // individually so a few row-level errors don't masquerade as a total
  // failure. Optimistically removes succeeded rows from the local view
  // so the editor sees their fix without waiting on a refetch.
  async function bulkClearFormat() {
    const ids = Array.from(selectedItemIds);
    if (ids.length === 0 || bulkClearing) return;
    setBulkClearing(true);
    try {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const res = await fetch("/api/production-items", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, format: null }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          return id;
        }),
      );
      const succeeded = new Set<string>();
      const failures: string[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") succeeded.add(r.value);
        else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
      if (succeeded.size > 0) {
        setData((prev) =>
          prev
            ? { ...prev, items: prev.items.filter((it) => !succeeded.has(it.id)) }
            : prev,
        );
      }
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        for (const id of succeeded) next.delete(id);
        return next;
      });
      if (failures.length === 0) {
        toast.success(
          succeeded.size === 1
            ? "Format cleared on 1 item."
            : `Format cleared on ${succeeded.size} items.`,
        );
      } else {
        toast.error(
          `Cleared ${succeeded.size} of ${ids.length}. ${failures.length} failed.`,
          { description: failures.slice(0, 2).join("\n\n"), duration: 10_000 },
        );
      }
    } finally {
      setBulkClearing(false);
    }
  }

  async function changeItemFormat(
    itemId: string,
    nextFormatName: string | null,
  ) {
    setUpdateFormatSaving(true);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, format: nextFormatName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Couldn't update format");
        return;
      }
      // The row no longer belongs to this format view — drop it locally so
      // the user immediately sees their fix without a full refetch.
      setData((prev) =>
        prev
          ? { ...prev, items: prev.items.filter((it) => it.id !== itemId) }
          : prev,
      );
      toast.success(
        nextFormatName ? `Moved to "${nextFormatName}"` : "Format cleared",
      );
      setUpdateFormatItemId(null);
      setUpdateFormatSearch("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update format");
    } finally {
      setUpdateFormatSaving(false);
    }
  }

  const sortedItems = useMemo(() => {
    const list = data?.items ?? [];
    const dir = contentSort.dir === "asc" ? 1 : -1;
    const keyFn = (item: ContentItem): string | number | null => {
      switch (contentSort.key) {
        case "title":
          return item.title?.toLowerCase() ?? null;
        case "account":
          return (
            item.account?.handle?.toLowerCase() ??
            item.platform?.[0]?.toLowerCase() ??
            null
          );
        case "publishedDate":
          return item.publishedDate ?? null;
        case "views":
          return item.views;
        case "likes":
          return item.likes;
        case "leads":
          return item.leads;
      }
    };
    return [...list].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      // Sort nulls to the bottom regardless of direction so empty rows don't
      // dominate the top of an asc sort.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data?.items, contentSort]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <BackLink
          brand={brand}
          listKey="formats"
          fallbackHref={`/${brand}/formats`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to formats
        </BackLink>
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          Format not found.
        </div>
      </div>
    );
  }

  const { items, metrics, children, ancestors } = data;
  const isPillar = !parentFormatId;

  // Flat list of (account, postType) options — one row per concrete
  // publishing target. Mirrors the legacy ALL_CHANNELS list but built from
  // real account data so brand-scoped accounts (e.g. SS Build) show up
  // automatically as new accounts are added.
  type ChannelOption = {
    key: string;
    accountId: string;
    postType: PostType | null;
    account: PickerAccount;
    platform: Platform;
  };
  const channelOptions: ChannelOption[] = [];
  for (const a of accounts) {
    if (!a.isActive) continue;
    const platform = toPlatform(a.platform);
    const postTypes = PLATFORM_META[platform].postTypes;
    if (postTypes.length === 0) {
      channelOptions.push({
        key: `${a.id}|`,
        accountId: a.id,
        postType: null,
        account: a,
        platform,
      });
    } else {
      for (const pt of postTypes) {
        channelOptions.push({
          key: `${a.id}|${pt}`,
          accountId: a.id,
          postType: pt,
          account: a,
          platform,
        });
      }
    }
  }
  const selectionLookup = new Set(selections.map((s) => selectionKey(s)));
  const childSelectionLookup = new Set(childSelections.map((s) => selectionKey(s)));

  // Build descendant set to prevent cycles in parent picker.
  const descendantIds = new Set<string>();
  const collectDescendants = (id: string) => {
    for (const f of allFormats) {
      if (f.parentFormatId === id && !descendantIds.has(f.id)) {
        descendantIds.add(f.id);
        collectDescendants(f.id);
      }
    }
  };
  collectDescendants(formatId);

  const parentOptions = allFormats
    .filter((f) => f.id !== formatId && !descendantIds.has(f.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedParent = parentFormatId
    ? allFormats.find((f) => f.id === parentFormatId) ?? null
    : null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb + autosave indicator + actions */}
      <div className="flex items-center justify-between gap-3">
        <BackLink
          brand={brand}
          listKey="formats"
          fallbackHref={`/${brand}/formats`}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          ← Formats
        </BackLink>
        <div className="flex items-center gap-3">
          {saveState.kind === "saving" && (
            <span className="text-xs text-muted-foreground">Saving…</span>
          )}
          {saveState.kind === "saved" && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {saveState.kind === "error" && (
            <span className="text-xs text-red-600" title={saveState.message}>
              Save failed
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: "outline", size: "sm" })}
              disabled={deleting}
              title="Actions for this format"
            >
              <MoreHorizontalIcon className="size-3.5" /> Actions
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={deleting}
                onClick={() => setDeleteConfirmOpen(true)}
                className="text-red-600 focus:text-red-700 focus:bg-red-50"
              >
                <Trash2Icon className="size-3.5" />
                {deleting ? "Deleting…" : "Delete format"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Hero: big format title + subtitle */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (next && next !== (data.format.name ?? "")) {
                void confirmAndRename(next);
              } else if (!next) {
                // Don't allow clearing — snap back to the saved value.
                setName(data.format.name);
              }
            }}
            placeholder="(unnamed)"
            className="text-3xl sm:text-4xl font-bold tracking-tight h-auto py-1 px-2 border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-muted/30 rounded-sm flex-1 min-w-0"
            aria-label="Format name"
          />
          <Badge
            variant="secondary"
            className={
              isPillar
                ? "bg-blue-100 text-blue-700"
                : "bg-purple-100 text-purple-700"
            }
          >
            {isPillar ? "Pillar" : "Derivative"}
          </Badge>
          <FormatStatusBadge status={data.format.provenStatus ?? null} />
        </div>
        <p className="text-sm text-muted-foreground px-2">
          {metrics.totalPosts} published post{metrics.totalPosts === 1 ? "" : "s"}
          {metrics.lastPublished && ` · last published ${formatDate(metrics.lastPublished)}`}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Total Posts
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {metrics.totalPosts.toLocaleString()}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">All time, published</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Total Views
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(metrics.totalViews)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Across all posts</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Avg Views / Post
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(metrics.avgViews)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Posts with view data</p>
        </div>
      </div>

      {/* Tabs: Details / Derivatives / Content */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FormatTab)}>
        <TabsList
          className="flex h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0 shadow-none"
        >
          {[
            { value: "details" as const, label: "Details", count: null as number | null },
            { value: "derivatives" as const, label: "Derivatives", count: children.length },
            { value: "content" as const, label: "Content", count: items.length },
          ].map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "group/tab flex-initial h-9 rounded-md px-3 text-sm font-medium transition-colors",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                "data-active:!bg-orange-100 data-active:!text-orange-700 data-active:!shadow-none",
                "after:!hidden",
              )}
            >
              <span>{tab.label}</span>
              {tab.count != null && tab.count > 0 && (
                <span
                  className={cn(
                    "ml-1.5 inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full px-1.5",
                    "text-[10px] font-semibold tabular-nums",
                    "bg-muted text-muted-foreground",
                    "group-data-active/tab:bg-orange-200 group-data-active/tab:text-orange-800",
                  )}
                >
                  {tab.count}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="details" className="pt-5 space-y-3">
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <PropertyRowGroup>
            <PropertyRow label="Parent format" tooltip="Derivative formats inherit the pillar's audience and analytics context. Pillar formats have no parent — leave blank if this is a top-level format.">
            <Popover open={parentPopoverOpen} onOpenChange={setParentPopoverOpen}>
              <PopoverTrigger className={`${PROPERTY_TRIGGER_CLASS} w-full flex items-center justify-between gap-2 cursor-pointer text-left`}>
                {selectedParent ? (
                  <span className="flex items-center gap-2 truncate">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700 shrink-0">
                      Child of
                    </span>
                    <span className="truncate">{selectedParent.name}</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                      No parent
                    </span>
                    <span className="text-muted-foreground">root / pillar</span>
                  </span>
                )}
                <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search formats…" />
                  <CommandList>
                    <CommandEmpty>No matching format.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        onSelect={() => {
                          setParentFormatId(null);
                          setParentPopoverOpen(false);
                          void persistField({ parentFormatId: null });
                        }}
                      >
                        <span className="flex items-center gap-2">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                            No parent
                          </span>
                          <span className="text-sm">Root / pillar</span>
                        </span>
                      </CommandItem>
                      {parentOptions.map((opt) => (
                        <CommandItem
                          key={opt.id}
                          value={opt.name}
                          onSelect={() => {
                            setParentFormatId(opt.id);
                            setParentPopoverOpen(false);
                            void persistField({ parentFormatId: opt.id });
                          }}
                          data-checked={parentFormatId === opt.id ? "true" : undefined}
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">
                              {opt.parentFormatId ? "derivative" : "root"}
                            </span>
                            <span className="text-sm">{opt.name}</span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            </PropertyRow>
            <PropertyRow label="Accounts" tooltip="Which brand account and post type this format publishes to. Each entry maps to one (account, post type) pair — e.g. SS + instagram_reel. Used to route items to the right publishing channel and filter the content table.">
            <Popover open={channelsPopoverOpen} onOpenChange={setChannelsPopoverOpen}>
              <PopoverTrigger className={`${PROPERTY_TRIGGER_CLASS} w-full flex min-h-8 items-center justify-between gap-2 cursor-pointer text-left`}>
                {selections.length === 0 ? (
                  <span className="text-muted-foreground">Select accounts…</span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1 overflow-hidden">
                    {selections.slice(0, 3).map((s) => {
                      const opt = channelOptions.find((o) => selectionKey(o) === selectionKey(s));
                      const account = opt?.account ?? accounts.find((a) => a.id === s.accountId) ?? null;
                      return (
                        <AccountBadge
                          key={selectionKey(s)}
                          account={account}
                          postType={s.postType}
                        />
                      );
                    })}
                    {selections.length > 3 && (
                      <span className="shrink-0 rounded bg-muted text-[10px] font-medium text-muted-foreground px-1.5 py-0.5">
                        +{selections.length - 3}
                      </span>
                    )}
                  </span>
                )}
                <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search accounts…" />
                  <CommandList>
                    <CommandEmpty>No accounts found.</CommandEmpty>
                    <CommandGroup>
                      {channelOptions.map((opt) => {
                        const isSelected = selectionLookup.has(opt.key);
                        const postTypeLabel = opt.postType
                          ? POST_TYPE_SHORT_LABEL[opt.postType]
                          : null;
                        return (
                          <CommandItem
                            key={opt.key}
                            value={`${opt.account.handle} ${opt.account.platform} ${opt.postType ?? ""}`}
                            onSelect={() =>
                              toggleSelection({
                                accountId: opt.accountId,
                                postType: opt.postType,
                              })
                            }
                          >
                            <span className="flex items-center gap-2 w-full">
                              <span
                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                  isSelected
                                    ? "bg-primary border-primary"
                                    : "border-input"
                                }`}
                              >
                                {isSelected && (
                                  <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                )}
                              </span>
                              <PlatformIcon platform={opt.platform} size={13} />
                              <span className="text-sm font-medium">@{opt.account.handle}</span>
                              {postTypeLabel && (
                                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {postTypeLabel}
                                </span>
                              )}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            </PropertyRow>
          </PropertyRowGroup>
          <PropertyRowGroup>
            <PropertyRow label="View threshold" tooltip="When a post in this format hits this many views, Hub & Spoke automatically creates a repurposed production item and kicks off the draft algorithm. Checked every hour. Leave blank to disable.">
            <Input
              type="number"
              value={viewThreshold}
              onChange={(e) => setViewThreshold(e.target.value)}
              onBlur={() => {
                const saved = data.format.viewThreshold;
                const next = viewThreshold ? parseInt(viewThreshold, 10) : null;
                if (next !== saved) void persistField({ viewThreshold: next });
              }}
              placeholder="e.g. 50000"
              className={PROPERTY_INPUT_CLASS}
            />
            </PropertyRow>
            <PropertyRow label="Editor" tooltip="The person responsible for producing content in this format. Used to filter the content board by editor.">
            <Popover open={editorPopoverOpen} onOpenChange={setEditorPopoverOpen}>
              <PopoverTrigger className={`${PROPERTY_TRIGGER_CLASS} w-full flex items-center justify-between gap-2 cursor-pointer text-left`}>
                {editor ? (
                  <span className="flex items-center gap-2 truncate">
                    <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                      {editor.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </span>
                    <span className="truncate">{editor}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Search team members…</span>
                )}
                <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by name or email..." />
                  <CommandList>
                    <CommandEmpty>No team members found.</CommandEmpty>
                    <CommandGroup>
                      {editor && (
                        <CommandItem
                          onSelect={() => {
                            setEditor("");
                            setEditorPopoverOpen(false);
                            void persistField({ editor: null });
                          }}
                          className="text-muted-foreground"
                        >
                          <span className="text-sm">Clear selection</span>
                        </CommandItem>
                      )}
                      {assignableUsers.map((u) => (
                        <CommandItem
                          key={u.id}
                          value={`${u.name ?? ""} ${u.email}`}
                          onSelect={() => {
                            setEditor(u.name ?? u.email);
                            setEditorPopoverOpen(false);
                            void persistField({ editor: u.name ?? u.email });
                          }}
                          data-checked={editor === (u.name ?? u.email) ? "true" : undefined}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                              {(u.name ?? u.email).split(" ").map((n) => n[0]).join("").slice(0, 2)}
                            </span>
                            <span className="flex flex-col">
                              <span className="text-sm font-medium">{u.name ?? u.email}</span>
                              <span className="text-xs text-muted-foreground">{u.email}</span>
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            </PropertyRow>
          </PropertyRowGroup>

          <PropertyRowSolo>
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">Skill</Label>
                  <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-700">
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2z"/></svg>
                    Claude-powered
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {preTemplateInstructions !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        setInstructions(preTemplateInstructions);
                        void persistField({ instructions: preTemplateInstructions || null });
                        setPreTemplateInstructions(null);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Revert
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPreTemplateInstructions(instructions);
                      const next = applyStarterTemplate(instructions);
                      setInstructions(next);
                      void persistField({ instructions: next });
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    Add template
                  </button>
                </div>
              </div>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={() => {
                  const saved = data.format.instructions ?? "";
                  if (instructions !== saved) {
                    void persistField({ instructions: instructions || null });
                  }
                }}
                rows={12}
                placeholder="Teach Claude this format: what it is, why it works, how to pick the moment, what to avoid. Click &quot;Add template&quot; for the structure."
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                A single skill definition. Claude reads it to generate clip ideas, run Descript edits, and write cross-post captions.
              </p>
            </div>
          </PropertyRowSolo>

          {/* Descript pack panel removed 2026-05-11. Pack prompt was folded
              into the format Skill above — `formats.instructions` is now the
              single source of truth that the Underlord agent reads. Supports
              `{{hook}}`, `{{startTimestamp}}`, `{{endTimestamp}}`,
              `{{durationSec}}`, `{{compositionId}}` placeholders inline in
              the Skill text. */}

          <PropertyRowSolo>
            <div className="px-3 py-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isClippableFormat}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setIsClippableFormat(next);
                    void persistField({ isClippableFormat: next });
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Clippable format</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    When ticked, this format gets its own Queue tab and the clip-idea agent (Splice) can target it. Multiple formats per brand can be clippable — each gets its own per-format hook style, output extras, and platform target from the format Skill&apos;s <code className="font-mono">## Clip Idea Generation</code> section. The four &quot;Create in Descript&quot; flows on clip triage also work for any clippable format.
                  </span>
                </span>
              </label>
              {isClippableFormat && (
                <div className="ml-6 mt-3 space-y-3 border-l border-border pl-3">
                  <div className="space-y-1">
                    <Label htmlFor="clip-target-post-type" className="text-xs">
                      Target post type
                    </Label>
                    <select
                      id="clip-target-post-type"
                      value={clipTargetPostType}
                      onChange={(e) => {
                        const next = e.target.value || null;
                        setClipTargetPostType(next ?? "");
                        void persistField({ clipTargetPostType: next });
                      }}
                      className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs")}
                    >
                      <option value="">— pick one —</option>
                      <option value="instagram_reel">instagram_reel</option>
                      <option value="tiktok">tiktok</option>
                      <option value="youtube_shorts">youtube_shorts</option>
                      <option value="x">x</option>
                      <option value="instagram_post">instagram_post</option>
                      <option value="linkedin">linkedin</option>
                      <option value="threads">threads</option>
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Sets <code className="font-mono">production_items.post_type</code> on each generated clip idea.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="clip-target-platform" className="text-xs">
                      Target platform(s)
                    </Label>
                    <Input
                      id="clip-target-platform"
                      type="text"
                      value={clipTargetPlatform.join(", ")}
                      onChange={(e) => {
                        const next = e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0);
                        setClipTargetPlatform(next);
                      }}
                      onBlur={() => {
                        void persistField({
                          clipTargetPlatform:
                            clipTargetPlatform.length > 0
                              ? clipTargetPlatform
                              : null,
                        });
                      }}
                      placeholder='Instagram Reel, X, YouTube Shorts'
                      className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs")}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Comma-separated. Stored on each generated clip&apos;s <code className="font-mono">production_items.platform</code> JSONB array.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="clip-aspect-ratio" className="text-xs">
                      Clip aspect ratio
                    </Label>
                    <select
                      id="clip-aspect-ratio"
                      value={clipAspectRatio}
                      onChange={(e) => {
                        const next = e.target.value || null;
                        setClipAspectRatio(next ?? "");
                        void persistField({ clipAspectRatio: next });
                      }}
                      className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs")}
                    >
                      <option value="">— derive from post type —</option>
                      <option value="9:16">9:16 (vertical)</option>
                      <option value="16:9">16:9 (horizontal)</option>
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Drives the Descript composition layout for clips in this format. Blank = 9:16 for Reel/Shorts/TikTok, 16:9 for X / YouTube long.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </PropertyRowSolo>

          <PropertyRowSolo>
            <div className="px-3 py-3 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="descript-layout-pack" className="text-sm font-medium">
                  Descript layout pack
                </Label>
                <p className="text-xs text-muted-foreground">
                  The layout pack Underlord applies to this format&apos;s Descript compositions (framing, hook-text track, captions). When set, prompts get a canonical apply-by-id instruction from the pack registry — it supersedes any pack link written in the Skill. Packs are validated against the Descript API when registered.
                </p>
                <select
                  id="descript-layout-pack"
                  value={descriptLayoutPackId ?? ""}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setDescriptLayoutPackId(next);
                    void persistField({ descriptLayoutPackId: next });
                  }}
                  className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs max-w-md")}
                >
                  <option value="">— none (use Skill text as-is) —</option>
                  {layoutPacks.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {!addPackOpen ? (
                  <button
                    type="button"
                    className="block text-[11px] text-primary underline underline-offset-2"
                    onClick={() => setAddPackOpen(true)}
                  >
                    Register a new pack…
                  </button>
                ) : (
                  <div className="mt-1 max-w-md space-y-1.5 rounded border border-border p-2">
                    <Input
                      value={newPackName}
                      onChange={(e) => setNewPackName(e.target.value)}
                      placeholder='Pack name exactly as in Descript, e.g. "Reels Layout"'
                      className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs")}
                    />
                    <Input
                      value={newPackUrl}
                      onChange={(e) => setNewPackUrl(e.target.value)}
                      placeholder="Paste the pack page link, e.g. https://web.descript.com/4ffdace6-…/5d5a7"
                      className={cn(PROPERTY_INPUT_CLASS, "h-8 text-xs")}
                    />
                    {addPackError && (
                      <p className="text-[11px] text-destructive">{addPackError}</p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={addPackBusy || !newPackName.trim() || !newPackUrl.trim()}
                        onClick={() => void addLayoutPack()}
                      >
                        {addPackBusy ? "Validating…" : "Validate & add"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => {
                          setAddPackOpen(false);
                          setAddPackError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </PropertyRowSolo>

          <PropertyRowSolo>
            <div className="px-3 py-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isCanvaFormat}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setIsCanvaFormat(next);
                    void persistField({ isCanvaFormat: next });
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Canva autofill format</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Items in this format are Canva-based posts. When ticked and the Skill above contains a Canva brand-template URL, clicking Create on a derivative spawns a Claude-extracted autofilled design via the Canva Connect API. Leave unchecked for formats where a Canva URL in the Skill is just a reference.
                  </span>
                </span>
              </label>
            </div>
          </PropertyRowSolo>

          <PropertyRowSolo>
            <div className="px-3 py-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={labelsAsOriginal}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setLabelsAsOriginal(next);
                    void persistField({ labelsAsOriginal: next });
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Label as original</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    New items created in this format default to source type
                    &ldquo;Original&rdquo; instead of &ldquo;Repurposed&rdquo;.
                    Tick for pillar / source-of-truth formats (e.g. Business
                    Breakdown, YouTube long-form). Leave unchecked for any
                    derivative format.
                  </span>
                </span>
              </label>
            </div>
          </PropertyRowSolo>
        </div>

        {ancestors.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2 px-2">
            Chain: {ancestors.map((a) => a.name).join(" → ")} → <strong>{name}</strong>
          </p>
        )}
        </TabsContent>

        <TabsContent value="derivatives" className="pt-5">
      {/* Derivatives — direct children in the repurpose tree */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Derivatives
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Direct children in the repurpose tree. When a post in this format hits one of these children&apos;s thresholds, a repurpose task is created for that child.
            </p>
          </div>
          <Button size="sm" onClick={openAddChild}>
            + Add
          </Button>
        </div>
        {children.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No derivatives yet. Click <span className="font-medium text-foreground">+ Add</span> to create one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-5 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Name
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Accounts
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground text-right">
                    Threshold
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Editor
                  </th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {children.map((f) => (
                  <tr
                    key={f.id}
                    className="border-b border-border/50 last:border-b-0 hover:bg-accent/30"
                  >
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Link
                          href={`/${brand}/formats/${f.id}`}
                          className="text-foreground hover:underline truncate block max-w-[260px] font-medium"
                        >
                          {f.name}
                        </Link>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-purple-50 text-purple-700">
                          Derivative
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1 max-w-[260px]">
                        {(f.accountChannels || []).slice(0, 3).map((c) => (
                          <AccountBadge
                            key={`${c.accountId}|${c.postType ?? ""}`}
                            account={c.account}
                            postType={c.postType}
                          />
                        ))}
                        {(f.accountChannels || []).length > 3 && (
                          <span className="text-xs text-muted-foreground">
                            +{(f.accountChannels || []).length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {f.viewThreshold != null ? f.viewThreshold.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {f.editor ? (
                        <span className="flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-medium shrink-0">
                            {f.editor.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                          </span>
                          <span className="truncate max-w-[120px]">{f.editor}</span>
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label="Row actions"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => router.push(`/${brand}/formats/${f.id}`)}>
                            Edit derivative
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={async () => {
                              if (!confirm(`Unlink "${f.name}" from this parent? It will become a root format.`)) return;
                              await setChildParent(f.id, null);
                            }}
                            className="text-red-600 focus:text-red-700"
                          >
                            Unlink (promote to root)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </TabsContent>

        <TabsContent value="content" className="pt-5">
      {/* Content list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              All content
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              All posts in this format. Click a column header to sort.
              Tick rows + Clear format to fix mis-categorized posts in bulk.
            </p>
          </div>
          {selectedItemIds.size > 0 && (
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-muted-foreground tabular-nums">
                {selectedItemIds.size} selected
              </span>
              <button
                type="button"
                onClick={() => setSelectedItemIds(new Set())}
                disabled={bulkClearing}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Clear selection
              </button>
              <button
                type="button"
                onClick={() => void bulkClearFormat()}
                disabled={bulkClearing}
                className="inline-flex h-8 items-center rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:bg-muted disabled:text-muted-foreground"
                title="Set format = null on every selected item. Removes them from this view."
              >
                {bulkClearing
                  ? `Clearing ${selectedItemIds.size}…`
                  : `Clear format (${selectedItemIds.size})`}
              </button>
            </div>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No content yet for this format.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-5 py-2 w-10">
                    {(() => {
                      // Header checkbox toggles every visible row. Indeterminate
                      // visual cue (input.indeterminate is set via ref-callback)
                      // when some-but-not-all are checked.
                      const allChecked =
                        sortedItems.length > 0 &&
                        sortedItems.every((it) => selectedItemIds.has(it.id));
                      const someChecked =
                        !allChecked &&
                        sortedItems.some((it) => selectedItemIds.has(it.id));
                      return (
                        <input
                          type="checkbox"
                          aria-label={allChecked ? "Deselect all" : "Select all"}
                          checked={allChecked}
                          ref={(el) => {
                            if (el) el.indeterminate = someChecked;
                          }}
                          onChange={() => {
                            setSelectedItemIds((prev) => {
                              if (allChecked) return new Set();
                              const next = new Set(prev);
                              for (const it of sortedItems) next.add(it.id);
                              return next;
                            });
                          }}
                          disabled={bulkClearing}
                          className="size-4 cursor-pointer rounded border-input accent-red-600 disabled:cursor-not-allowed"
                        />
                      );
                    })()}
                  </th>
                  <ContentSortHeader label="Title" sortKeyName="title" sort={contentSort} onToggle={toggleContentSort} />
                  <ContentSortHeader label="Account" sortKeyName="account" sort={contentSort} onToggle={toggleContentSort} />
                  <ContentSortHeader label="Published" sortKeyName="publishedDate" sort={contentSort} onToggle={toggleContentSort} />
                  <ContentSortHeader label="Views" sortKeyName="views" sort={contentSort} onToggle={toggleContentSort} align="right" />
                  <ContentSortHeader label="Likes" sortKeyName="likes" sort={contentSort} onToggle={toggleContentSort} align="right" />
                  <ContentSortHeader label="Leads" sortKeyName="leads" sort={contentSort} onToggle={toggleContentSort} align="right" />
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr
                    key={item.id}
                    className={cn(
                      "border-b border-border/50 last:border-b-0 hover:bg-accent/30",
                      selectedItemIds.has(item.id) && "bg-red-50/40",
                    )}
                  >
                    <td className="px-5 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.title ?? "row"}`}
                        checked={selectedItemIds.has(item.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedItemIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                        disabled={bulkClearing}
                        className="size-4 cursor-pointer rounded border-input accent-red-600 disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <CoverImg
                          src={coverImageUrl(item)}
                          className="w-8 h-8 rounded object-cover shrink-0"
                        />
                        <div className="min-w-0">
                          <Link
                            href={`/${brand}/content/${item.id}`}
                            className="text-foreground hover:underline truncate block max-w-[420px]"
                          >
                            {item.title || item.publishedLink || "Untitled"}
                          </Link>
                          {item.status && item.status !== "Published" && (
                            <span
                              className={cn(
                                "inline-flex items-center mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border",
                                statusClassWithPalette(item.status, statusPalette),
                              )}
                            >
                              {item.status}
                            </span>
                          )}
                          {item.descriptCompositionUrl && (
                            <a
                              href={item.descriptCompositionUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] font-medium text-purple-700 hover:underline mt-0.5"
                              title="Open composition in Descript"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                              Descript →
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {item.account ? (
                        <AccountBadge
                          account={item.account}
                          postType={item.postType}
                          variant="compact"
                        />
                      ) : (
                        <span className="text-muted-foreground">
                          {(item.platform || []).join(", ") || "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
                      {formatDate(item.publishedDate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span className={item.viewsEstimated ? "text-muted-foreground" : "text-foreground"}>
                        {item.views != null ? formatCompact(item.views) : "—"}
                        {item.viewsEstimated && (
                          <span className="ml-1 text-[10px] text-muted-foreground">est</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {item.likes != null ? formatCompact(item.likes) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {item.leads != null ? formatCompact(item.leads) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label="Row actions"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {isPillar && !item.descriptProjectUrl && (
                            <DropdownMenuItem onClick={() => openDescriptModal(item)}>
                              Add to Descript
                            </DropdownMenuItem>
                          )}
                          {isPillar && item.descriptProjectUrl && (
                            <>
                              <DropdownMenuItem
                                onClick={() => window.open(item.descriptProjectUrl!, "_blank", "noopener,noreferrer")}
                              >
                                Open in Descript
                              </DropdownMenuItem>
                              {descriptClipTargets.length > 0 && (
                                <DropdownMenuItem onClick={() => openClipModal(item)}>
                                  Clip out…
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => openDescriptModal(item)}>
                                Re-import to Descript
                              </DropdownMenuItem>
                            </>
                          )}
                          {item.publishedLink && (
                            <DropdownMenuItem
                              onClick={() => window.open(item.publishedLink!, "_blank", "noopener,noreferrer")}
                            >
                              Open original
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setUpdateFormatItemId(item.id)}
                          >
                            Update format…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </TabsContent>
      </Tabs>

      {/* Clip out modal */}
      <Dialog open={!!clipItem} onOpenChange={(o) => { if (!o) closeClipModal(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Clip out</DialogTitle>
          </DialogHeader>
          {clipItem && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-foreground truncate">
                  {clipItem.title || "Untitled"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Creates a new composition in this pillar&apos;s Descript project based on the target format&apos;s clip prompt. For MVP the timestamps are a random 30-second window.
                </p>
              </div>
              {clipResult ? (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-2">
                  <div className="font-medium text-foreground">
                    Clip queued for &ldquo;{clipResult.targetFormatName}&rdquo;.
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Clip window: {Math.floor(clipResult.window.startSec / 60)}:{String(clipResult.window.startSec % 60).padStart(2, "0")} –
                    {" "}{Math.floor(clipResult.window.endSec / 60)}:{String(clipResult.window.endSec % 60).padStart(2, "0")}.
                    Descript is processing (~35 seconds). Refresh the project in Descript to see the new composition.
                  </p>
                  <a
                    href={clipResult.projectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {clipResult.projectUrl}
                  </a>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Prompt sent</summary>
                    <pre className="mt-2 whitespace-pre-wrap">{clipResult.prompt}</pre>
                  </details>
                  <div className="flex justify-end pt-2">
                    <Button variant="outline" onClick={closeClipModal}>Close</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="clip-target">Target format</Label>
                    <select
                      id="clip-target"
                      value={clipTargetId}
                      onChange={(e) => setClipTargetId(e.target.value)}
                      className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">Pick a target format…</option>
                      {descriptClipTargets.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    {clipTargetId && (() => {
                      const t = descriptClipTargets.find((f) => f.id === clipTargetId);
                      const preview = t?.instructions?.trim();
                      return (
                        <div className="text-xs text-muted-foreground rounded-md bg-muted/50 border border-border p-2.5 mt-1">
                          <div className="font-medium text-foreground mb-1">Prompt</div>
                          {preview ? (
                            <p className="whitespace-pre-wrap">{preview}</p>
                          ) : (
                            <p className="italic">No prompt on this format — Claude will likely respond with a no-action message. Add a prompt that describes a Descript clip to enable.</p>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {clipError && (
                    <p className="text-xs text-destructive">{clipError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={closeClipModal} disabled={clipLoading}>
                      Cancel
                    </Button>
                    <Button onClick={submitClip} disabled={clipLoading || !clipTargetId}>
                      {clipLoading ? "Clipping…" : "Clip out"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add derivative modal */}
      <Dialog open={addChildOpen} onOpenChange={(o) => { if (!o) setAddChildOpen(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New derivative of &ldquo;{name}&rdquo;</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                placeholder="e.g. X clip"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label>Accounts</Label>
              <Popover open={childChannelsOpen} onOpenChange={setChildChannelsOpen}>
                <PopoverTrigger className="flex min-h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs hover:bg-accent cursor-pointer">
                  {childSelections.length === 0 ? (
                    <span className="text-muted-foreground">Select accounts…</span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1 overflow-hidden">
                      {childSelections.slice(0, 3).map((s) => {
                        const opt = channelOptions.find((o) => selectionKey(o) === selectionKey(s));
                        const account = opt?.account ?? accounts.find((a) => a.id === s.accountId) ?? null;
                        return (
                          <AccountBadge
                            key={selectionKey(s)}
                            account={account}
                            postType={s.postType}
                          />
                        );
                      })}
                      {childSelections.length > 3 && (
                        <span className="shrink-0 rounded bg-muted text-[10px] font-medium text-muted-foreground px-1.5 py-0.5">
                          +{childSelections.length - 3}
                        </span>
                      )}
                    </span>
                  )}
                  <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search accounts…" />
                    <CommandList>
                      <CommandEmpty>No accounts found.</CommandEmpty>
                      <CommandGroup>
                        {channelOptions.map((opt) => {
                          const isSelected = childSelectionLookup.has(opt.key);
                          const postTypeLabel = opt.postType
                            ? POST_TYPE_SHORT_LABEL[opt.postType]
                            : null;
                          return (
                            <CommandItem
                              key={opt.key}
                              value={`${opt.account.handle} ${opt.account.platform} ${opt.postType ?? ""}`}
                              onSelect={() =>
                                toggleChildSelection({
                                  accountId: opt.accountId,
                                  postType: opt.postType,
                                })
                              }
                            >
                              <span className="flex items-center gap-2 w-full">
                                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? "bg-primary border-primary" : "border-input"}`}>
                                  {isSelected && (
                                    <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                  )}
                                </span>
                                <PlatformIcon platform={opt.platform} size={13} />
                                <span className="text-sm font-medium">@{opt.account.handle}</span>
                                {postTypeLabel && (
                                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {postTypeLabel}
                                  </span>
                                )}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label>View Threshold</Label>
              <Input
                type="number"
                value={childViewThreshold}
                onChange={(e) => setChildViewThreshold(e.target.value)}
                placeholder="e.g. 50000"
              />
              <p className="text-xs text-muted-foreground">
                When a &ldquo;{name}&rdquo; post hits this number of views, a repurpose task is created for this derivative.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Editor (Content Creator)</Label>
              <Popover open={childEditorOpen} onOpenChange={setChildEditorOpen}>
                <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                  {childEditor ? (
                    <span className="flex items-center gap-2 truncate">
                      <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                        {childEditor.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                      </span>
                      <span className="truncate">{childEditor}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Search team members…</span>
                  )}
                  <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search by name or email..." />
                    <CommandList>
                      <CommandEmpty>No team members found.</CommandEmpty>
                      <CommandGroup>
                        {childEditor && (
                          <CommandItem
                            onSelect={() => {
                              setChildEditor("");
                                                        setChildEditorOpen(false);
                            }}
                            className="text-muted-foreground"
                          >
                            <span className="text-sm">Clear selection</span>
                          </CommandItem>
                        )}
                        {assignableUsers.map((u) => (
                          <CommandItem
                            key={u.id}
                            value={`${u.name ?? ""} ${u.email}`}
                            onSelect={() => {
                              setChildEditor(u.name ?? u.email);
                              setChildEditorOpen(false);
                            }}
                            data-checked={childEditor === (u.name ?? u.email) ? "true" : undefined}
                          >
                            <span className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                                {(u.name ?? u.email).split(" ").map((n) => n[0]).join("").slice(0, 2)}
                              </span>
                              <span className="flex flex-col">
                                <span className="text-sm font-medium">{u.name ?? u.email}</span>
                                <span className="text-xs text-muted-foreground">{u.email}</span>
                              </span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Skill</Label>
                <button
                  type="button"
                  onClick={() => setChildInstructions(applyStarterTemplate(childInstructions))}
                  className="text-xs text-primary hover:underline"
                >
                  Add template
                </button>
              </div>
              <Textarea
                value={childInstructions}
                onChange={(e) => setChildInstructions(e.target.value)}
                placeholder="Describe this derivative as a Claude-style skill."
                rows={6}
                className="font-mono text-xs"
              />
            </div>

            {childError && <p className="text-xs text-destructive">{childError}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddChildOpen(false)} disabled={savingChild}>
                Cancel
              </Button>
              <Button onClick={submitAddChild} disabled={savingChild || !childName.trim()}>
                {savingChild ? "Creating…" : "Create derivative"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add to Descript modal */}
      <Dialog open={!!descriptItem} onOpenChange={(o) => { if (!o) closeDescriptModal(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add to Descript</DialogTitle>
          </DialogHeader>
          {descriptItem && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-foreground truncate">
                  {descriptItem.title || "Untitled"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Creates a new Descript project importing this video.
                </p>
              </div>
              {descriptResult ? (
                <>
                  <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-2">
                    <div className="font-medium text-foreground">Project created.</div>
                    <a
                      href={descriptResult.projectUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline break-all"
                    >
                      {descriptResult.projectUrl}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {descriptMode === "upload"
                        ? "Upload complete. Descript is processing — open the link to watch progress."
                        : "Descript is still importing the video — open the link to watch progress."}
                    </p>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="outline" onClick={closeDescriptModal}>Close</Button>
                  </div>
                </>
              ) : (
                <>
                  {/* Mode tabs */}
                  <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
                    <button
                      type="button"
                      onClick={() => setDescriptMode("upload")}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        descriptMode === "upload"
                          ? "bg-card text-foreground font-medium shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Upload file
                    </button>
                    <button
                      type="button"
                      onClick={() => setDescriptMode("url")}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        descriptMode === "url"
                          ? "bg-card text-foreground font-medium shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Paste URL
                    </button>
                  </div>

                  {descriptMode === "upload" ? (
                    <div className="space-y-2">
                      <Label htmlFor="descript-file">Video file</Label>
                      <Input
                        id="descript-file"
                        type="file"
                        accept="video/*,audio/*"
                        onChange={(e) => setDescriptFile(e.target.files?.[0] || null)}
                        disabled={descriptStage === "uploading" || descriptStage === "creating"}
                      />
                      {descriptFile && (
                        <p className="text-xs text-muted-foreground">
                          {descriptFile.name} · {(descriptFile.size / (1024 * 1024)).toFixed(1)} MB
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Uploaded directly from your browser to Descript. No middleman.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="descript-url">Video URL</Label>
                      <Input
                        id="descript-url"
                        type="url"
                        value={descriptUrl}
                        onChange={(e) => setDescriptUrl(e.target.value)}
                        placeholder="https://drive.google.com/file/d/…"
                      />
                      <p className="text-xs text-muted-foreground">
                        Google Drive share link (set to &ldquo;anyone with the link&rdquo;), or any
                        public direct-download video URL. YouTube URLs won&apos;t work.
                      </p>
                    </div>
                  )}

                  {descriptStage === "uploading" && (
                    <div className="space-y-1.5">
                      <div className="w-full bg-border rounded-full h-1.5">
                        <div
                          className="h-1.5 rounded-full bg-primary transition-all"
                          style={{ width: `${descriptProgress}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Uploading to Descript… {descriptProgress}%
                      </p>
                    </div>
                  )}

                  {descriptError && (
                    <div className="space-y-1">
                      <p className="text-xs text-destructive">{descriptError}</p>
                      {s3KeyForRetry && (
                        <p className="text-[10px] text-muted-foreground">
                          File is uploaded — retry sends it to Descript without re-uploading.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={closeDescriptModal}
                      disabled={descriptStage === "uploading" || descriptStage === "creating"}
                    >
                      Cancel
                    </Button>
                    {s3KeyForRetry && descriptError ? (
                      <Button
                        onClick={retryDescriptImport}
                        disabled={descriptStage === "creating"}
                      >
                        {descriptStage === "creating" ? "Retrying…" : "Retry Descript import"}
                      </Button>
                    ) : (
                      <Button
                        onClick={
                          descriptMode === "upload" ? submitDescriptUpload : submitDescriptUrl
                        }
                        disabled={
                          descriptStage === "creating" ||
                          descriptStage === "uploading" ||
                          (descriptMode === "upload" ? !descriptFile : !descriptUrl.trim())
                        }
                      >
                        {descriptStage === "creating"
                          ? "Creating…"
                          : descriptStage === "uploading"
                          ? "Uploading…"
                          : descriptMode === "upload"
                          ? "Upload & create"
                          : "Create project"}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!updateFormatItemId}
        onOpenChange={(o) => {
          if (!o) {
            setUpdateFormatItemId(null);
            setUpdateFormatSearch("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle>Update format</DialogTitle>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search formats…"
              value={updateFormatSearch}
              onValueChange={setUpdateFormatSearch}
              autoFocus
            />
            <CommandList className="max-h-[420px]">
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  disabled={updateFormatSaving}
                  onSelect={() =>
                    updateFormatItemId &&
                    changeItemFormat(updateFormatItemId, null)
                  }
                >
                  <span className="text-muted-foreground italic">
                    Clear format (no format)
                  </span>
                </CommandItem>
              </CommandGroup>
              {filteredFormatsForUpdate.length > 0 ? (
                <CommandGroup heading="All formats">
                  {filteredFormatsForUpdate.map((f) => (
                    <CommandItem
                      key={f.id}
                      value={f.name}
                      disabled={updateFormatSaving}
                      onSelect={() =>
                        updateFormatItemId &&
                        changeItemFormat(updateFormatItemId, f.name)
                      }
                    >
                      {f.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : (
                <CommandEmpty>No matching format.</CommandEmpty>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* Delete format confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={(o) => { if (!o) setDeleteConfirmOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete format?</DialogTitle>
            <DialogDescription className="pt-1 space-y-2">
              <span className="block">
                This will permanently delete <strong>{name}</strong> and all{" "}
                <strong>{items.length} content item{items.length === 1 ? "" : "s"}</strong> associated with it.
              </span>
              <span className="block text-red-600 font-medium">This cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Yes, delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

