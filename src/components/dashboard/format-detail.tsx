"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { channelsForBrand } from "@/lib/config/channels";
import { applyStarterTemplate } from "@/lib/format-skill";

interface AsanaMember {
  gid: string;
  name: string;
  email: string;
}

interface FormatRow {
  id: string;
  name: string;
  brand: string;
  channels: string[];
  viewThreshold: number | null;
  editor: string | null;
  editorAsanaGid: string | null;
  producer: string | null;
  producerAsanaGid: string | null;
  instructions: string | null;
  parentFormatId: string | null;
}

interface ContentItem {
  id: string;
  title: string | null;
  platform: string[] | null;
  publishedDate: string | null;
  publishedLink: string | null;
  thumbnail: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  leads: number | null;
  salesAmount: number | null;
  status: string | null;
  viewsEstimated: boolean;
  descriptProjectUrl: string | null;
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

export function FormatDetail({ brand, formatId }: FormatDetailProps) {
  const router = useRouter();
  const ALL_CHANNELS = channelsForBrand(brand);

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [allFormats, setAllFormats] = useState<FormatRow[]>([]);
  const [asanaMembers, setAsanaMembers] = useState<AsanaMember[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [viewThreshold, setViewThreshold] = useState("");
  const [editor, setEditor] = useState("");
  const [editorAsanaGid, setEditorAsanaGid] = useState("");
  const [producer, setProducer] = useState("");
  const [producerAsanaGid, setProducerAsanaGid] = useState("");
  const [instructions, setInstructions] = useState("");
  const [parentFormatId, setParentFormatId] = useState<string | null>(null);

  const [editorPopoverOpen, setEditorPopoverOpen] = useState(false);
  const [producerPopoverOpen, setProducerPopoverOpen] = useState(false);
  const [channelsPopoverOpen, setChannelsPopoverOpen] = useState(false);
  const [parentPopoverOpen, setParentPopoverOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // New-derivative dialog state.
  const [addChildOpen, setAddChildOpen] = useState(false);
  const [childName, setChildName] = useState("");
  const [childChannels, setChildChannels] = useState<string[]>([]);
  const [childViewThreshold, setChildViewThreshold] = useState("");
  const [childEditor, setChildEditor] = useState("");
  const [childEditorGid, setChildEditorGid] = useState("");
  const [childProducer, setChildProducer] = useState("");
  const [childProducerGid, setChildProducerGid] = useState("");
  const [childInstructions, setChildInstructions] = useState("");
  const [childEditorOpen, setChildEditorOpen] = useState(false);
  const [childProducerOpen, setChildProducerOpen] = useState(false);
  const [childChannelsOpen, setChildChannelsOpen] = useState(false);
  const [savingChild, setSavingChild] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);

  function openAddChild() {
    setChildName("");
    setChildChannels([]);
    setChildViewThreshold("");
    setChildEditor("");
    setChildEditorGid("");
    setChildProducer("");
    setChildProducerGid("");
    setChildInstructions("");
    setChildError(null);
    setAddChildOpen(true);
  }

  function toggleChildChannel(ch: string) {
    setChildChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
    );
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
          channels: childChannels,
          viewThreshold: childViewThreshold ? parseInt(childViewThreshold, 10) : null,
          editor: childEditor || null,
          editorAsanaGid: childEditorGid || null,
          producer: childProducer || null,
          producerAsanaGid: childProducerGid || null,
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
    setChannels(f.channels || []);
    setViewThreshold(f.viewThreshold != null ? String(f.viewThreshold) : "");
    setEditor(f.editor || "");
    setEditorAsanaGid(f.editorAsanaGid || "");
    setProducer(f.producer || "");
    setProducerAsanaGid(f.producerAsanaGid || "");
    setInstructions(f.instructions || "");
    setParentFormatId(f.parentFormatId ?? null);
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
    async function loadMembers() {
      try {
        const res = await fetch("/api/asana-members");
        if (res.ok) {
          setAsanaMembers(await res.json());
        }
      } catch (err) {
        console.error("Failed to fetch Asana members:", err);
      }
    }
    loadMembers();
  }, []);

  function toggleChannel(c: string) {
    setChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
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
        channels: child.channels || [],
        viewThreshold: child.viewThreshold ?? null,
        editor: child.editor ?? null,
        editorAsanaGid: child.editorAsanaGid ?? null,
        producer: child.producer ?? null,
        producerAsanaGid: child.producerAsanaGid ?? null,
        instructions: child.instructions ?? null,
        parentFormatId: newParentId,
      }),
    });
    await load();
  }

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    try {
      const body = {
        id: formatId,
        name,
        brand,
        channels,
        viewThreshold: viewThreshold ? parseInt(viewThreshold, 10) : null,
        editor: editor || null,
        editorAsanaGid: editorAsanaGid || null,
        producer: producer || null,
        producerAsanaGid: producerAsanaGid || null,
        instructions: instructions || null,
        parentFormatId,
      };
      const res = await fetch("/api/formats", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSavedAt(Date.now());
        await load();
      }
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this format? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await fetch("/api/formats", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: formatId }),
      });
      router.push(`/${brand}/formats`);
    } catch (err) {
      console.error("Delete failed:", err);
      setDeleting(false);
    }
  }

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
        <Link
          href={`/${brand}/formats`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to formats
        </Link>
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          Format not found.
        </div>
      </div>
    );
  }

  const { items, metrics, children, ancestors } = data;
  const isPillar = !parentFormatId;

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
      {/* Breadcrumb / back */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/${brand}/formats`}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          ← Formats
        </Link>
        <Button
          variant="outline"
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300 hover:bg-red-50"
        >
          {deleting ? "Deleting…" : "Delete format"}
        </Button>
      </div>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            {name || "(unnamed)"}
          </h1>
          <Badge
            variant="secondary"
            className={
              isPillar
                ? "bg-blue-100 text-blue-700"
                : "bg-purple-100 text-purple-700"
            }
          >
            {isPillar ? "Pillar" : "Repurposed"}
          </Badge>
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          {metrics.totalPosts} published post{metrics.totalPosts === 1 ? "" : "s"}
          {metrics.lastPublished && ` · last published ${formatDate(metrics.lastPublished)}`}
        </p>
      </div>

      {/* Metrics */}
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

      {/* Edit form */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Format details</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Edits save when you click Save changes.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Parent Format</Label>
            <Popover open={parentPopoverOpen} onOpenChange={setParentPopoverOpen}>
              <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
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
            {ancestors.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Chain: {ancestors.map((a) => a.name).join(" → ")} → <strong>{name}</strong>
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-2">
            <Label>Channels</Label>
            <Popover open={channelsPopoverOpen} onOpenChange={setChannelsPopoverOpen}>
              <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                {channels.length === 0 ? (
                  <span className="text-muted-foreground">Select channels…</span>
                ) : (
                  <span className="flex items-center gap-1 overflow-hidden">
                    <span className="truncate">
                      {channels.slice(0, 2).join(", ")}
                    </span>
                    {channels.length > 2 && (
                      <span className="shrink-0 rounded bg-muted text-[10px] font-medium text-muted-foreground px-1.5 py-0.5">
                        +{channels.length - 2}
                      </span>
                    )}
                  </span>
                )}
                <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search channels…" />
                  <CommandList>
                    <CommandEmpty>No channels found.</CommandEmpty>
                    <CommandGroup>
                      {ALL_CHANNELS.map((ch) => {
                        const selected = channels.includes(ch);
                        return (
                          <CommandItem
                            key={ch}
                            value={ch}
                            onSelect={() => toggleChannel(ch)}
                          >
                            <span className="flex items-center gap-2 w-full">
                              <span
                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                  selected
                                    ? "bg-primary border-primary"
                                    : "border-input"
                                }`}
                              >
                                {selected && (
                                  <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                )}
                              </span>
                              <span className="text-sm">{ch}</span>
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
              value={viewThreshold}
              onChange={(e) => setViewThreshold(e.target.value)}
              placeholder="e.g. 50000"
            />
          </div>
          <div className="space-y-2">
            <Label>Editor (Content Creator)</Label>
            <Popover open={editorPopoverOpen} onOpenChange={setEditorPopoverOpen}>
              <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
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
                            setEditorAsanaGid("");
                            setEditorPopoverOpen(false);
                          }}
                          className="text-muted-foreground"
                        >
                          <span className="text-sm">Clear selection</span>
                        </CommandItem>
                      )}
                      {asanaMembers.map((m) => (
                        <CommandItem
                          key={m.gid}
                          value={`${m.name} ${m.email}`}
                          onSelect={() => {
                            setEditor(m.name);
                            setEditorAsanaGid(m.gid);
                            setEditorPopoverOpen(false);
                          }}
                          data-checked={editorAsanaGid === m.gid ? "true" : undefined}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                              {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                            </span>
                            <span className="flex flex-col">
                              <span className="text-sm font-medium">{m.name}</span>
                              <span className="text-xs text-muted-foreground">{m.email}</span>
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
            <Label>Producer (Reviewer + Publisher)</Label>
            <Popover open={producerPopoverOpen} onOpenChange={setProducerPopoverOpen}>
              <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                {producer ? (
                  <span className="flex items-center gap-2 truncate">
                    <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium shrink-0">
                      {producer.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </span>
                    <span className="truncate">{producer}</span>
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
                      {producer && (
                        <CommandItem
                          onSelect={() => {
                            setProducer("");
                            setProducerAsanaGid("");
                            setProducerPopoverOpen(false);
                          }}
                          className="text-muted-foreground"
                        >
                          <span className="text-sm">Clear selection</span>
                        </CommandItem>
                      )}
                      {asanaMembers.map((m) => (
                        <CommandItem
                          key={m.gid}
                          value={`${m.name} ${m.email}`}
                          onSelect={() => {
                            setProducer(m.name);
                            setProducerAsanaGid(m.gid);
                            setProducerPopoverOpen(false);
                          }}
                          data-checked={producerAsanaGid === m.gid ? "true" : undefined}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium shrink-0">
                              {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                            </span>
                            <span className="flex flex-col">
                              <span className="text-sm font-medium">{m.name}</span>
                              <span className="text-xs text-muted-foreground">{m.email}</span>
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
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label className="text-sm">Skill</Label>
              <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-700">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2z"/></svg>
                Claude-powered
              </span>
            </div>
            <button
              type="button"
              onClick={() => setInstructions(applyStarterTemplate(instructions))}
              className="text-xs text-primary hover:underline"
            >
              Load starter template
            </button>
          </div>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={10}
            placeholder="Teach Claude this format: what it is, why it works, how to pick the moment, what to avoid. Click “Load starter template” for the structure."
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            A single skill definition. Claude reads it to dispatch Repurpose actions (e.g. Descript clipping) and it&apos;s attached to every Asana task.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs text-primary">Saved.</span>
          )}
        </div>
      </div>

      {/* Derivatives — direct children in the repurpose tree */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Derivatives
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Direct children in the repurpose tree. When a post in this format hits one of these children&apos;s thresholds, an Asana task is created for that child.
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
                    Channels
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground text-right">
                    Threshold
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Editor
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Producer
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
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {(f.channels || []).slice(0, 3).map((ch) => (
                          <Badge key={ch} variant="secondary" className="text-xs">
                            {ch}
                          </Badge>
                        ))}
                        {(f.channels || []).length > 3 && (
                          <span className="text-xs text-muted-foreground">
                            +{(f.channels || []).length - 3}
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
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {f.producer ? (
                        <span className="flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-medium shrink-0">
                            {f.producer.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                          </span>
                          <span className="truncate max-w-[120px]">{f.producer}</span>
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

      {/* Content list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            All content
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            All posts in this format, sorted by views.
          </p>
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
                  <th className="px-5 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Title
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Platform
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Published
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground text-right">
                    Views
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground text-right">
                    Likes
                  </th>
                  <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground text-right">
                    Leads
                  </th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        {item.thumbnail && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.thumbnail}
                            alt=""
                            className="w-8 h-8 rounded object-cover shrink-0"
                          />
                        )}
                        <div className="min-w-0">
                          <Link
                            href={`/${brand}/content/${item.id}`}
                            className="text-foreground hover:underline truncate block max-w-[420px]"
                          >
                            {item.title || item.publishedLink || "Untitled"}
                          </Link>
                          {item.status && item.status !== "Published" && (
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                              {item.status}
                            </span>
                          )}
                          {item.descriptProjectUrl && (
                            <a
                              href={item.descriptProjectUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] font-medium text-purple-700 hover:underline mt-0.5"
                              title="Open in Descript"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                              Descript →
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {(item.platform || []).join(", ") || "—"}
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
                placeholder="e.g. Twitter clip"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label>Channels</Label>
              <Popover open={childChannelsOpen} onOpenChange={setChildChannelsOpen}>
                <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                  {childChannels.length === 0 ? (
                    <span className="text-muted-foreground">Select channels…</span>
                  ) : (
                    <span className="flex items-center gap-1 overflow-hidden">
                      <span className="truncate">{childChannels.slice(0, 2).join(", ")}</span>
                      {childChannels.length > 2 && (
                        <span className="shrink-0 rounded bg-muted text-[10px] font-medium text-muted-foreground px-1.5 py-0.5">
                          +{childChannels.length - 2}
                        </span>
                      )}
                    </span>
                  )}
                  <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search channels…" />
                    <CommandList>
                      <CommandEmpty>No channels found.</CommandEmpty>
                      <CommandGroup>
                        {ALL_CHANNELS.map((ch) => {
                          const selected = childChannels.includes(ch);
                          return (
                            <CommandItem key={ch} value={ch} onSelect={() => toggleChildChannel(ch)}>
                              <span className="flex items-center gap-2 w-full">
                                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${selected ? "bg-primary border-primary" : "border-input"}`}>
                                  {selected && (
                                    <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                  )}
                                </span>
                                <span className="text-sm">{ch}</span>
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
                When a &ldquo;{name}&rdquo; post hits this number of views, an Asana task is created for this derivative.
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
                              setChildEditorGid("");
                              setChildEditorOpen(false);
                            }}
                            className="text-muted-foreground"
                          >
                            <span className="text-sm">Clear selection</span>
                          </CommandItem>
                        )}
                        {asanaMembers.map((m) => (
                          <CommandItem
                            key={m.gid}
                            value={`${m.name} ${m.email}`}
                            onSelect={() => {
                              setChildEditor(m.name);
                              setChildEditorGid(m.gid);
                              setChildEditorOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                                {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                              </span>
                              <span className="flex flex-col">
                                <span className="text-sm font-medium">{m.name}</span>
                                <span className="text-xs text-muted-foreground">{m.email}</span>
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
              <Label>Producer (Reviewer + Publisher)</Label>
              <Popover open={childProducerOpen} onOpenChange={setChildProducerOpen}>
                <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                  {childProducer ? (
                    <span className="flex items-center gap-2 truncate">
                      <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium shrink-0">
                        {childProducer.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                      </span>
                      <span className="truncate">{childProducer}</span>
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
                        {childProducer && (
                          <CommandItem
                            onSelect={() => {
                              setChildProducer("");
                              setChildProducerGid("");
                              setChildProducerOpen(false);
                            }}
                            className="text-muted-foreground"
                          >
                            <span className="text-sm">Clear selection</span>
                          </CommandItem>
                        )}
                        {asanaMembers.map((m) => (
                          <CommandItem
                            key={m.gid}
                            value={`${m.name} ${m.email}`}
                            onSelect={() => {
                              setChildProducer(m.name);
                              setChildProducerGid(m.gid);
                              setChildProducerOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium shrink-0">
                                {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                              </span>
                              <span className="flex flex-col">
                                <span className="text-sm font-medium">{m.name}</span>
                                <span className="text-xs text-muted-foreground">{m.email}</span>
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
                <Label>Prompt</Label>
                <button
                  type="button"
                  onClick={() => setChildInstructions(applyStarterTemplate(childInstructions))}
                  className="text-xs text-primary hover:underline"
                >
                  Load starter template
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
    </div>
  );
}
