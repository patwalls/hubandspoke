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
  contentType: string | null;
  repurposeTargetIds: string[];
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
  const [contentType, setContentType] = useState<string>("pillar");
  const [repurposeTargetIds, setRepurposeTargetIds] = useState<string[]>([]);

  const [editorPopoverOpen, setEditorPopoverOpen] = useState(false);
  const [producerPopoverOpen, setProducerPopoverOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  async function submitDescriptUpload() {
    if (!descriptItem || !descriptFile) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptProgress(0);

    let uploadUrl: string, projectUrl: string;
    try {
      const res = await fetch("/api/descript/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "upload",
          projectName: descriptItem.title || "Imported video",
          fileName: descriptFile.name,
          contentType: descriptFile.type || "video/mp4",
          fileSize: descriptFile.size,
          itemId: descriptItem.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDescriptError(json.error || `HTTP ${res.status}`);
        setDescriptStage("idle");
        return;
      }
      uploadUrl = json.uploadUrl;
      projectUrl = json.projectUrl;
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Request failed");
      setDescriptStage("idle");
      return;
    }

    // Upload the file directly from the browser to Descript's signed URL.
    setDescriptStage("uploading");
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
        xhr.addEventListener("error", () => reject(new Error("Upload failed")));
        xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader(
          "Content-Type",
          descriptFile!.type || "application/octet-stream"
        );
        xhr.send(descriptFile);
      });
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Upload failed");
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
    setContentType(f.contentType || "pillar");
    setRepurposeTargetIds(f.repurposeTargetIds || []);
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

  function toggleRepurpose(id: string) {
    setRepurposeTargetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
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
        contentType,
        repurposeTargetIds,
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

  const { items, metrics } = data;
  const isPillar = (contentType || "pillar") === "pillar";

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
            <Label>Content Type</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setContentType("pillar")}
                className={`flex-1 flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm transition-all ${
                  isPillar
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                <span className="text-base">🎯</span>
                <span className="font-medium">Pillar</span>
              </button>
              <button
                type="button"
                onClick={() => setContentType("repurposed")}
                className={`flex-1 flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm transition-all ${
                  !isPillar
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                <span className="text-base">🔄</span>
                <span className="font-medium">Repurposed</span>
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Channels</Label>
          <div className="flex flex-wrap gap-2">
            {ALL_CHANNELS.map((ch) => (
              <Badge
                key={ch}
                variant={channels.includes(ch) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => toggleChannel(ch)}
              >
                {ch}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>View Threshold</Label>
            <Input
              type="number"
              value={viewThreshold}
              onChange={(e) => setViewThreshold(e.target.value)}
              placeholder="e.g. 50000"
            />
            <p className="text-xs text-muted-foreground">
              Triggers repurpose tasks when a post hits this view count.
            </p>
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
          <Label>Format Instructions</Label>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            placeholder="Add instructions, loom links, style guides, etc. Included in Asana tasks."
          />
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

      {/* Repurpose targets / automations */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Repurpose &amp; automations
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            When a post in this format hits the view threshold, Asana tasks are
            created for each selected target.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {allFormats
            .filter((f) => f.id !== formatId)
            .map((f) => (
              <Badge
                key={f.id}
                variant={
                  repurposeTargetIds.includes(f.id) ? "default" : "outline"
                }
                className="cursor-pointer"
                onClick={() => toggleRepurpose(f.id)}
              >
                {f.name}
              </Badge>
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Click Save changes above to apply.
        </p>
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
                          {item.publishedLink ? (
                            <a
                              href={item.publishedLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-foreground hover:underline truncate block max-w-[420px]"
                            >
                              {item.title || item.publishedLink}
                            </a>
                          ) : (
                            <span className="text-foreground truncate block max-w-[420px]">
                              {item.title || "Untitled"}
                            </span>
                          )}
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
                    <p className="text-xs text-destructive">{descriptError}</p>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={closeDescriptModal}
                      disabled={descriptStage === "uploading" || descriptStage === "creating"}
                    >
                      Cancel
                    </Button>
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
