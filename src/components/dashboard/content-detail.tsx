"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, FileTextIcon, FilmIcon } from "lucide-react";
import type { ProductionItem } from "@/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BrandFormat {
  id: string;
  name: string;
  contentType: string | null;
  instructions: string | null;
}

interface DetailResponse {
  item: ProductionItem;
  derivatives: ProductionItem[];
  formatNames: string[];
  formats: BrandFormat[];
  repurposeTargets: BrandFormat[];
}

interface ContentDetailProps {
  brand: string;
  contentId: string;
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

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
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

export function ContentDetail({ brand, contentId }: ContentDetailProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Per-format repurpose state, keyed by format id
  type RepurposeState = {
    state: "running" | "previewed" | "clipped" | "no_action" | "error";
    label?: string;          // short status pill text on the button
    message?: string;        // longer explanation under the button
    descriptPrompt?: string; // composed directive (preview or actual)
    projectUrl?: string;
    firedAt?: "preview" | "real";
  };
  const [clipStatus, setClipStatus] = useState<Record<string, RepurposeState>>(
    {}
  );

  // Descript upload modal state
  const [descriptModalOpen, setDescriptModalOpen] = useState(false);
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

  async function callRepurpose(targetFormatId: string, mode: "preview" | "real") {
    setClipStatus((prev) => ({
      ...prev,
      [targetFormatId]: { state: "running", firedAt: mode },
    }));
    const url =
      mode === "preview"
        ? "/api/descript/clip-out/preview"
        : "/api/descript/clip-out";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: contentId, targetFormatId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: {
            state: "error",
            message: json.error || `HTTP ${res.status}`,
          },
        }));
        return;
      }
      if (json.mode === "descript_clip") {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: {
            state: mode === "preview" ? "previewed" : "clipped",
            label:
              mode === "preview"
                ? "preview ready"
                : "clip queued",
            descriptPrompt: json.descriptPrompt,
            projectUrl: json.projectUrl,
          },
        }));
        if (mode === "real") {
          // Pull the new trigger row in. Refresh again a bit later so the
          // composition ID resolves from the background poll.
          load();
          setTimeout(() => load(), 40_000);
        }
      } else if (json.mode === "no_action") {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: {
            state: "no_action",
            message: json.message || "No automation for this prompt yet.",
          },
        }));
      } else {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: { state: "error", message: "Unexpected response" },
        }));
      }
    } catch (err) {
      setClipStatus((prev) => ({
        ...prev,
        [targetFormatId]: {
          state: "error",
          message: err instanceof Error ? err.message : "Request failed",
        },
      }));
    }
  }

  function openDescriptModal() {
    setDescriptMode("upload");
    setDescriptFile(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptModalOpen(true);
  }

  function closeDescriptModal() {
    setDescriptModalOpen(false);
    setDescriptFile(null);
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptStage("idle");
    setDescriptProgress(0);
  }

  async function submitDescriptUrl() {
    if (!data || !descriptUrl.trim()) return;
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
          projectName: data.item.title || "Imported video",
          itemId: contentId,
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
    if (!data || !descriptFile) return;
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
          projectName: data.item.title || "Imported video",
          fileName: descriptFile.name,
          contentType: descriptFile.type || "video/mp4",
          fileSize: descriptFile.size,
          itemId: contentId,
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

  // Form state
  const [title, setTitle] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [format, setFormat] = useState("");
  const [publishedLink, setPublishedLink] = useState("");
  const [publishedDate, setPublishedDate] = useState("");
  const [views, setViews] = useState("");
  const [likes, setLikes] = useState("");
  const [comments, setComments] = useState("");
  const [clicks, setClicks] = useState("");
  const [leads, setLeads] = useState("");
  const [salesAmount, setSalesAmount] = useState("");

  const platformOptions = brand === "matg" ? MATG_PLATFORMS : SS_PLATFORMS;

  const applyItem = useCallback((item: ProductionItem) => {
    setTitle(item.title || "");
    setPlatforms(item.platform || []);
    setFormat(item.format || "");
    setPublishedLink(item.publishedLink || "");
    setPublishedDate(item.publishedDate || "");
    setViews(item.views != null ? String(item.views) : "");
    setLikes(item.likes != null ? String(item.likes) : "");
    setComments(item.comments != null ? String(item.comments) : "");
    setClicks(item.clicks != null ? String(item.clicks) : "");
    setLeads(item.leads != null ? String(item.leads) : "");
    setSalesAmount(
      item.salesAmount != null ? String(item.salesAmount) : ""
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/production-items/${contentId}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      const json = (await res.json()) as DetailResponse;
      setData(json);
      applyItem(json.item);
    } catch (err) {
      console.error("Failed to load content detail:", err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [contentId, applyItem]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: contentId,
          title,
          platform: platforms,
          format: format || null,
          publishedLink: publishedLink || null,
          publishedDate,
          views: views ? parseInt(views, 10) : null,
          likes: likes ? parseInt(likes, 10) : null,
          comments: comments ? parseInt(comments, 10) : null,
          clicks: clicks ? parseInt(clicks, 10) : null,
          leads: leads ? parseInt(leads, 10) : null,
          salesAmount: salesAmount || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSaveResult({
          success: false,
          message: err.error || "Failed to save",
        });
        return;
      }
      setSaveResult({ success: true, message: "Saved." });
      await load();
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this post? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/production-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSaveResult({
          success: false,
          message: err.error || "Failed to delete",
        });
        setDeleting(false);
        return;
      }
      router.push(`/${brand}/content`);
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
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
          href={`/${brand}/content`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to content
        </Link>
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          Post not found.
        </div>
      </div>
    );
  }

  const { item, derivatives, formatNames, repurposeTargets } = data;
  const brandFormats = formatNames;
  const isYouTube = !!item.youtubeId;
  const isPublished = !!item.publishedLink;
  const notionUrl = item.notionId
    ? `https://www.notion.so/${item.notionId.replace(/-/g, "")}`
    : null;

  const hasDescriptProject = !!item.descriptProjectId;
  const descriptProjectUrl = item.descriptProjectUrl;

  return (
    <div className="space-y-6">
      {/* Breadcrumb / back */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/${brand}/content`}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          ← Content
        </Link>
        {!isYouTube && (
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={deleting}
            className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300 hover:bg-red-50"
          >
            {deleting ? "Deleting…" : "Delete post"}
          </Button>
        )}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            {item.thumbnail && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={item.thumbnail}
                alt=""
                className="w-16 h-10 rounded object-cover shrink-0"
              />
            )}
            <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
              {item.title || "(Untitled)"}
            </h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {(item.platform || []).map((p) => (
              <Badge
                key={p}
                variant="secondary"
                className="bg-accent text-muted-foreground border border-border"
              >
                {p}
              </Badge>
            ))}
            {item.format && (
              <span className="text-xs text-muted-foreground">
                · {item.format}
              </span>
            )}
            {item.publishedDate && (
              <span className="text-xs text-muted-foreground">
                · published {formatDate(item.publishedDate)}
              </span>
            )}
          </div>
          {item.utmCampaign && (
            <p className="mt-1 text-[11px] text-muted-foreground font-mono">
              {item.utmCampaign}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {item.publishedLink && (
            <a
              href={item.publishedLink}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
              title="Open the live post"
            >
              <ExternalLinkIcon className="size-3.5" /> Published
            </a>
          )}
          {notionUrl && (
            <a
              href={notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
              title="Open the Notion page for this post"
            >
              <FileTextIcon className="size-3.5" /> Notion
            </a>
          )}
          {item.descriptProjectUrl && (
            <a
              href={item.descriptProjectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
              title="Open the Descript project"
            >
              <FilmIcon className="size-3.5" /> Descript
            </a>
          )}
        </div>
      </div>

      {/* Metrics — only shown once the post is actually live */}
      {isPublished && (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Views
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.views)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {item.viewsEstimated ? "Estimated from likes" : "Reported"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Likes
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.likes)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">On this post</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Comments
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.comments)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">On this post</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Clicks
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(item.clicks)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {item.leads != null
              ? `${item.leads.toLocaleString()} leads`
              : "Link clicks"}
          </p>
        </div>
      </div>
      )}

      {/* Post details — edit form (above derivatives so editing is one scroll) */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Post details
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isYouTube
                ? "Auto-synced from YouTube — fields are read-only."
                : "Edits save when you click Save changes."}
            </p>
          </div>
          {!isYouTube && (
            <Button onClick={handleSave} disabled={saving || !title || !platforms.length || !publishedDate}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <Label>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isYouTube}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Platform</Label>
            <Select
              value={platforms[0] || ""}
              onValueChange={(v) => setPlatforms(v ? [v] : [])}
              disabled={isYouTube}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select platform…" />
              </SelectTrigger>
              <SelectContent>
                {platformOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {brandFormats.length > 0 && (
            <div className="space-y-2">
              <Label>Format</Label>
              <Select
                value={format}
                onValueChange={(v) => setFormat(v || "")}
                disabled={isYouTube}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select format…" />
                </SelectTrigger>
                <SelectContent>
                  {brandFormats.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Published Link</Label>
            <Input
              value={publishedLink}
              onChange={(e) => setPublishedLink(e.target.value)}
              placeholder="https://…"
              disabled={isYouTube}
            />
          </div>
          <div className="space-y-2">
            <Label>Published Date</Label>
            <Input
              type="date"
              value={publishedDate}
              onChange={(e) => setPublishedDate(e.target.value)}
              disabled={isYouTube}
            />
          </div>
        </div>

        <div className="rounded-lg border border-dashed border-gray-300 p-3 space-y-3">
          <p className="text-xs text-muted-foreground font-medium">Metrics</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Views</Label>
              <Input
                type="number"
                value={views}
                onChange={(e) => setViews(e.target.value)}
                placeholder="0"
                disabled={isYouTube}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Likes</Label>
              <Input
                type="number"
                value={likes}
                onChange={(e) => setLikes(e.target.value)}
                placeholder="0"
                disabled={isYouTube}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Comments</Label>
              <Input
                type="number"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="0"
                disabled={isYouTube}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Clicks</Label>
              <Input
                type="number"
                value={clicks}
                onChange={(e) => setClicks(e.target.value)}
                placeholder="0"
                disabled={isYouTube}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Leads</Label>
              <Input
                type="number"
                value={leads}
                onChange={(e) => setLeads(e.target.value)}
                placeholder="0"
                disabled={isYouTube}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Sales $</Label>
              <Input
                type="number"
                value={salesAmount}
                onChange={(e) => setSalesAmount(e.target.value)}
                placeholder="0"
                step="0.01"
                disabled={isYouTube}
              />
            </div>
          </div>
        </div>

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
      </div>

      {/* Derivative content — same look/feel as Content Performance table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Derivative content
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {derivatives.length}
              </span>
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Everything in Notion with this post set as Pillar Content — every
              status, every format.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-accent/50">
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Title
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Platform
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Format
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                  Published
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Views
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Likes
                </th>
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Comments
                </th>
              </tr>
            </thead>
            <tbody>
              {derivatives.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                    <div className="flex items-center gap-3">
                      {d.thumbnail && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={d.thumbnail}
                          alt=""
                          className="w-20 h-12 rounded object-cover shrink-0"
                        />
                      )}
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-medium text-foreground truncate inline-flex items-center gap-1.5">
                          <Link
                            href={`/${brand}/content/${d.id}`}
                            className="hover:text-primary hover:underline transition-colors truncate"
                          >
                            {d.title || "(Untitled)"}
                          </Link>
                          {d.publishedLink && (
                            <a
                              href={d.publishedLink}
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
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {d.platform?.map((p) => (
                        <span
                          key={p}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {d.format || "-"}
                  </td>
                  <td className="px-3 py-2">
                    {d.status ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border">
                        {d.status}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                    {d.publishedDate || "-"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                    {d.views != null ? (
                      <span title={d.viewsEstimated ? "Estimated from likes" : undefined}>
                        {d.viewsEstimated ? "~" : ""}{d.views.toLocaleString()}
                      </span>
                    ) : "-"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                    {d.likes?.toLocaleString() || "-"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                    {d.comments?.toLocaleString() || "-"}
                  </td>
                </tr>
              ))}
              {derivatives.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    No derivatives linked in Notion yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Repurpose to format */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Repurpose to format
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Click a target format to create a new composition in this post&apos;s Descript
              project using that format&apos;s clip prompt. A random 30-second window is used
              for this MVP.
            </p>
          </div>
          {descriptProjectUrl && (
            <a
              href={descriptProjectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-purple-700 hover:underline inline-flex items-center gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
              Open Descript project →
            </a>
          )}
        </div>

        {!hasDescriptProject && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex items-center justify-between gap-3 flex-wrap">
            <span>
              This post doesn&apos;t have a Descript project yet. Add one so the
              clip-out buttons below can run.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={openDescriptModal}
              className="shrink-0"
            >
              Add to Descript
            </Button>
          </div>
        )}

        {repurposeTargets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repurposed-type formats for this brand yet.{" "}
            <Link
              href={`/${brand}/formats`}
              className="text-primary hover:underline"
            >
              Add a format
            </Link>{" "}
            with content type <span className="font-mono">Repurposed</span> to see it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {repurposeTargets.map((f) => {
              const st = clipStatus[f.id];
              const busy = st?.state === "running";
              const disabled = !hasDescriptProject || busy;
              return (
                <div
                  key={f.id}
                  className="flex items-start gap-2 flex-wrap border border-border rounded-lg p-2.5 bg-card/50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {f.name}
                    </div>
                    {(st?.state === "previewed" || st?.state === "clipped") &&
                      st.descriptPrompt && (
                        <div className="mt-1.5 text-[11px] text-muted-foreground bg-muted/40 border border-border rounded-md p-2 whitespace-pre-wrap font-mono">
                          {st.descriptPrompt}
                        </div>
                      )}
                    {st?.state === "clipped" && st.projectUrl && (
                      <div className="mt-1">
                        <a
                          href={st.projectUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-primary hover:underline"
                        >
                          Open in Descript →
                        </a>
                      </div>
                    )}
                    {st?.state === "no_action" && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {st.message}
                      </p>
                    )}
                    {st?.state === "error" && (
                      <p className="mt-1.5 text-[11px] text-destructive">
                        {st.message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => callRepurpose(f.id, "preview")}
                      disabled={busy}
                      title="Ask Claude what directive it would send — no Descript call."
                      className="inline-flex items-center h-7 px-2.5 rounded-full border border-border bg-card text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy && st?.firedAt === "preview"
                        ? "Previewing…"
                        : "Preview"}
                    </button>
                    <button
                      type="button"
                      onClick={() => callRepurpose(f.id, "real")}
                      disabled={disabled}
                      title={
                        hasDescriptProject
                          ? "Claude reads this format's prompt, composes a directive, and sends it to Descript."
                          : "Add this item to Descript first."
                      }
                      className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy && st?.firedAt === "real"
                        ? "Repurposing…"
                        : "Repurpose"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium">Preview</span> asks Claude (Haiku) what directive it would send to Descript, without spending Descript credits.{" "}
          <span className="font-medium">Repurpose</span> does the same and then fires the clip job. Descript&apos;s own agent picks the moment from the transcript.
        </p>
      </div>

      {/* Add to Descript modal */}
      <Dialog open={descriptModalOpen} onOpenChange={(o) => { if (!o) closeDescriptModal(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add to Descript</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-foreground truncate">
                {item.title || "Untitled"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Creates a new Descript project for this post so you can clip it
                into other formats.
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
                      Google Drive share link (set to &ldquo;anyone with the link&rdquo;), or
                      any public direct-download video URL. YouTube URLs won&apos;t work.
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
        </DialogContent>
      </Dialog>

    </div>
  );
}
