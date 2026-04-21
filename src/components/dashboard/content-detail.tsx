"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, FilmIcon, RefreshCwIcon } from "lucide-react";
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
import { PillarPicker, type PillarOption } from "./pillar-picker";
import { ContentActivity } from "./content-activity";
import { UserChip } from "./user-chip";
import { renderInstructions } from "@/lib/utils/markdown";

interface BrandFormat {
  id: string;
  name: string;
  parentFormatId: string | null;
  instructions: string | null;
}

type DerivativeRow = ProductionItem & { depth: number };

interface PillarRef {
  id: string;
  title: string | null;
  format: string | null;
}

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface RepostRow {
  id: string;
  title: string | null;
  thumbnail: string | null;
  status: string | null;
  platform: string[] | null;
  publishedDate: string | null;
  publishedLink: string | null;
  views: number | null;
  viewsEstimated: boolean | null;
  likes: number | null;
  comments: number | null;
  createdAt: string;
}

interface RepostedFromRef {
  id: string;
  title: string | null;
  publishedDate: string | null;
  views: number | null;
  evergreenReasoning: string | null;
}

interface DetailResponse {
  item: ProductionItem;
  derivatives: DerivativeRow[];
  descendantViewsTotal: number;
  formatNames: string[];
  formats: BrandFormat[];
  repurposeTargets: BrandFormat[];
  pillar: PillarRef | null;
  producer: AssignableUser | null;
  editor: AssignableUser | null;
  reposts: RepostRow[];
  crossPosts: RepostRow[];
  repostedFrom: RepostedFromRef | null;
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

const STATUS_OPTIONS = [
  "Idea",
  "Assigned",
  "Review",
  "Final Review",
  "Ready To Publish",
  "Published",
  "Killed",
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

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function ContentDetail({ brand, contentId }: ContentDetailProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);

  // Auto-clear the "Saved" pill so it doesn't stay pinned after a single edit.
  // Errors persist until the next save attempt so the user can read them.
  useEffect(() => {
    if (saveState.kind !== "saved") return;
    const t = setTimeout(() => setSaveState({ kind: "idle" }), 1500);
    return () => clearTimeout(t);
  }, [saveState]);

  // Per-format repurpose state, keyed by format id
  type RepurposeKind = "descript_clip" | "manual_task";
  type RepurposeState = {
    state: "running" | "previewed" | "clipped" | "created" | "error";
    kind?: RepurposeKind;
    label?: string;          // short status pill text on the button
    message?: string;        // error / info text under the button
    descriptPrompt?: string; // clip directive (when kind === descript_clip)
    guidance?: string;       // editor brief (when kind === manual_task)
    projectUrl?: string;     // Descript project URL
    firedAt?: "preview" | "real";
  };
  const [clipStatus, setClipStatus] = useState<Record<string, RepurposeState>>(
    {}
  );
  const [repurposingAll, setRepurposingAll] = useState(false);

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

  // Manual metrics refresh state for the Sync button on the metrics grid.
  // `error` holds a non-fatal note (e.g. "not found in recent feed") so the
  // user sees why metrics didn't move even though the call succeeded.
  const [syncState, setSyncState] = useState<
    | { kind: "idle" }
    | { kind: "syncing" }
    | { kind: "synced" }
    | { kind: "note"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

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
            kind: "descript_clip",
            label: mode === "preview" ? "preview ready" : "clip queued",
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
      } else if (json.mode === "manual_task") {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: {
            state: mode === "preview" ? "previewed" : "created",
            kind: "manual_task",
            label: mode === "preview" ? "preview ready" : "task created",
            guidance: json.guidance,
          },
        }));
        if (mode === "real") {
          load();
          setTimeout(() => load(), 40_000);
        }
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

  async function repurposeAll(targetFormatIds: string[]) {
    if (repurposingAll || targetFormatIds.length === 0) return;
    setRepurposingAll(true);
    try {
      // Fire sequentially — Claude + Notion + Descript calls are rate-sensitive
      // and this keeps per-format state transitions readable in the UI.
      for (const id of targetFormatIds) {
        await callRepurpose(id, "real");
      }
    } finally {
      setRepurposingAll(false);
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
    setS3KeyForRetry(null);
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

  const [s3KeyForRetry, setS3KeyForRetry] = useState<string | null>(null);

  async function callDescriptForS3Key(key: string, projectName: string) {
    const res = await fetch("/api/descript/create-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "s3", s3Key: key, projectName, itemId: contentId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.projectUrl as string;
  }

  async function retryDescriptImport() {
    if (!data || !s3KeyForRetry) return;
    setDescriptError(null);
    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        s3KeyForRetry,
        data.item.title || "Imported video"
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
    if (!data || !descriptFile) return;
    setDescriptStage("creating");
    setDescriptError(null);
    setDescriptResult(null);
    setDescriptProgress(0);
    setS3KeyForRetry(null);

    let uploadUrl: string, key: string, bucket: string;
    try {
      const res = await fetch("/api/uploads/s3-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
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
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.send(descriptFile);
      });
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Upload failed");
      setDescriptStage("idle");
      return;
    }

    try {
      const res = await fetch("/api/uploads/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
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

    setS3KeyForRetry(key);

    setDescriptStage("creating");
    try {
      const projectUrl = await callDescriptForS3Key(
        key,
        data.item.title || "Imported video"
      );
      setDescriptResult({ projectUrl });
      setDescriptStage("done");
      load();
    } catch (err) {
      setDescriptError(err instanceof Error ? err.message : "Descript import failed");
      setDescriptStage("idle");
    }
  }

  // Form state
  const [title, setTitle] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [format, setFormat] = useState("");
  const [formatPickerOpen, setFormatPickerOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [pillar, setPillar] = useState<PillarOption | null>(null);
  const [producerUserId, setProducerUserId] = useState<string>("");
  const [editorUserId, setEditorUserId] = useState<string>("");
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [publishedLink, setPublishedLink] = useState("");
  const [publishedDate, setPublishedDate] = useState("");
  const [sourceType, setSourceType] = useState<string>("original");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setAssignableUsers(json.users || []);
      } catch {
        // Non-fatal: the form still works without suggestions.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const platformOptions = brand === "matg" ? MATG_PLATFORMS : SS_PLATFORMS;

  const applyItem = useCallback((item: ProductionItem, pillarRef: PillarRef | null) => {
    setTitle(item.title || "");
    setPlatforms(item.platform || []);
    setFormat(item.format || "");
    setStatus(item.status || "");
    setPillar(pillarRef);
    setProducerUserId(item.producerUserId || "");
    setEditorUserId(item.editorUserId || "");
    setPublishedLink(item.publishedLink || "");
    setPublishedDate(item.publishedDate || "");
    setSourceType(item.sourceType || "original");
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
      applyItem(json.item, json.pillar ?? null);
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

  // Every field auto-persists through here. The PUT route accepts partial
  // bodies, so we send only what changed. Server response is merged back into
  // `data.item` so derived flags like `isPublished` stay current without a full
  // reload (which would steal focus from the input the user just blurred).
  const persistField = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setSaveState({ kind: "saving" });
      try {
        const res = await fetch("/api/production-items", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: contentId, ...patch }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        setData((prev) =>
          prev ? { ...prev, item: { ...prev.item, ...payload } } : prev
        );
        setActivityRefreshKey((k) => k + 1);
        // sourceType flips can materialize reposted_from_item_id and thus the
        // "Reposted from" source card. That card reads from data.repostedFrom
        // which only the GET endpoint computes — refetch to surface it.
        if ("sourceType" in patch) void load();
        setSaveState(
          payload.notionSyncWarning
            ? { kind: "error", message: `Saved. Notion: ${payload.notionSyncWarning}` }
            : { kind: "saved" }
        );
        return true;
      } catch (e) {
        setSaveState({
          kind: "error",
          message: e instanceof Error ? e.message : "Save failed",
        });
        return false;
      }
    },
    [contentId, load]
  );

  const handleSync = useCallback(async () => {
    setSyncState({ kind: "syncing" });
    try {
      const res = await fetch(`/api/production-items/${contentId}/sync`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      // Merge the fresh metrics onto the local item so the stat cards update
      // without a full detail reload (which would steal input focus).
      setData((prev) => {
        if (!prev) return prev;
        const patch: Partial<ProductionItem> = {};
        if (json.views != null) patch.views = json.views;
        if (json.likes != null) patch.likes = json.likes;
        if (json.comments != null) patch.comments = json.comments;
        patch.lastPerformanceSyncAt = json.syncedAt ?? new Date().toISOString();
        return { ...prev, item: { ...prev.item, ...patch } };
      });
      if (json.updated) {
        setSyncState({ kind: "synced" });
        setTimeout(() => setSyncState({ kind: "idle" }), 2500);
      } else {
        setSyncState({
          kind: "note",
          message: json.note || "No fresh data returned",
        });
        setTimeout(() => setSyncState({ kind: "idle" }), 5000);
      }
    } catch (err) {
      setSyncState({
        kind: "error",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }, [contentId]);

  async function handleDelete() {
    if (!confirm("Delete this post? This cannot be undone.")) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        setDeleteError(err.error || "Failed to delete");
        setDeleting(false);
        return;
      }
      router.push(`/${brand}/content`);
    } catch (err) {
      setDeleteError(String(err));
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
  const isPrePublish = item.status !== "Published";

  // Resolve the currently-selected producer/editor for the trigger display.
  // Prefer the freshly-loaded assignable list (stays in sync with local
  // selections), and fall back to the detail endpoint's authoritative record
  // so we still render name + avatar even if the user isn't in the list.
  const producerUser = producerUserId
    ? assignableUsers.find((u) => u.id === producerUserId) ??
      (data.producer?.id === producerUserId ? data.producer : null)
    : null;
  const editorUser = editorUserId
    ? assignableUsers.find((u) => u.id === editorUserId) ??
      (data.editor?.id === editorUserId ? data.editor : null)
    : null;
  const currentFormat =
    data.formats.find((f) => f.name === item.format) ?? null;
  const formatPrompt = currentFormat?.instructions ?? null;
  const notionUrl = item.notionId
    ? `https://www.notion.so/${item.notionId.replace(/-/g, "")}`
    : null;

  const hasDescriptProject = !!item.descriptProjectId;

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
            {item.sourceType === "repost" && (
              <Badge
                variant="secondary"
                className="bg-amber-100 text-amber-900 border border-amber-200"
                title="This is a repost of an earlier piece of content"
              >
                Repost
              </Badge>
            )}
            {item.sourceType === "cross_post" && (
              <Badge
                variant="secondary"
                className="bg-indigo-100 text-indigo-900 border border-indigo-200"
                title="Same content syndicated to a different platform"
              >
                Cross-post
              </Badge>
            )}
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
          {item.mediaS3Key && (
            <a
              href={`/api/uploads/download?itemId=${item.id}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              title={`Download original media from S3${item.mediaSizeBytes ? ` (${(item.mediaSizeBytes / 1024 / 1024).toFixed(1)} MB)` : ""}`}
            >
              <DownloadIcon className="size-3.5" /> Download
            </a>
          )}
        </div>
      </div>

      {/* Source card — shown for reposts and cross-posts. The header badge
          carries the "is a X" signal; this gives context (source link + AI
          reason) using the same card styling as the rest of the page. */}
      {(item.sourceType === "repost" || item.sourceType === "cross_post") &&
        data.repostedFrom && (
        <div className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-2">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            {item.sourceType === "cross_post" ? "Cross-posted from" : "Reposted from"}
          </h3>
          <div className="flex items-baseline gap-2 flex-wrap">
            <Link
              href={`/${brand}/content/${data.repostedFrom.id}`}
              className="text-sm font-medium text-foreground hover:text-primary hover:underline"
            >
              {data.repostedFrom.title || "(untitled)"}
            </Link>
            <span className="text-xs text-muted-foreground">
              {data.repostedFrom.publishedDate &&
                `originally ${formatDate(data.repostedFrom.publishedDate)}`}
              {data.repostedFrom.views != null && (
                <> · {formatCompact(data.repostedFrom.views)} views</>
              )}
            </span>
          </div>
          {data.repostedFrom.evergreenReasoning && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">
                Why this was recommended:
              </span>{" "}
              {data.repostedFrom.evergreenReasoning}
            </p>
          )}
        </div>
      )}

      {/* Metrics — only shown once the post is actually live */}
      {isPublished && (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground">
            {item.lastPerformanceSyncAt
              ? `Metrics last synced ${formatRelative(item.lastPerformanceSyncAt)}`
              : "Metrics not yet synced"}
          </p>
          <div className="flex items-center gap-2">
            {syncState.kind === "synced" && (
              <span className="text-[11px] text-green-600">Synced</span>
            )}
            {syncState.kind === "note" && (
              <span
                className="text-[11px] text-muted-foreground"
                title={syncState.message}
              >
                {syncState.message}
              </span>
            )}
            {syncState.kind === "error" && (
              <span
                className="text-[11px] text-red-600"
                title={syncState.message}
              >
                {syncState.message}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncState.kind === "syncing"}
              className="h-7 text-xs gap-1.5"
            >
              <RefreshCwIcon
                className={`h-3 w-3 ${syncState.kind === "syncing" ? "animate-spin" : ""}`}
              />
              {syncState.kind === "syncing" ? "Syncing…" : "Sync metrics"}
            </Button>
          </div>
        </div>
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
            Total Views
          </p>
          <div className="mt-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatCompact(data?.descendantViewsTotal ?? 0)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Across all derivatives
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
      </div>
      )}

      {/* Post details — edit form (above derivatives so editing is one scroll) */}
      <div
        className={
          isPrePublish
            ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start"
            : undefined
        }
      >
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        {(isYouTube || saveState.kind !== "idle") && (
          <div className="flex items-center justify-end gap-2 -mb-1 min-h-[18px]">
            {isYouTube && (
              <span className="text-[11px] text-muted-foreground">
                Auto-synced from YouTube — fields are read-only.
              </span>
            )}
            {saveState.kind === "saving" && (
              <span className="text-[11px] text-muted-foreground">Saving…</span>
            )}
            {saveState.kind === "saved" && (
              <span className="text-[11px] text-green-600">Saved</span>
            )}
            {saveState.kind === "error" && (
              <span className="text-[11px] text-red-600" title={saveState.message}>
                {saveState.message}
              </span>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if ((item.title ?? "") !== title) void persistField({ title });
            }}
            disabled={isYouTube}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Platform</Label>
            <Select
              value={platforms[0] || ""}
              onValueChange={(v) => {
                const next = v ? [v] : [];
                setPlatforms(next);
                void persistField({ platform: next });
              }}
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
            <div className="space-y-1.5">
              <Label>Format</Label>
              <Popover open={formatPickerOpen} onOpenChange={setFormatPickerOpen}>
                <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                  {format ? (
                    <span className="truncate">{format}</span>
                  ) : (
                    <span className="text-muted-foreground">Select format…</span>
                  )}
                  <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                </PopoverTrigger>
                <PopoverContent className="w-96 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search formats…" />
                    <CommandList>
                      <CommandEmpty>No matching format.</CommandEmpty>
                      <CommandGroup>
                        {format && (
                          <CommandItem
                            onSelect={() => {
                              setFormat("");
                              void persistField({ format: null });
                              setFormatPickerOpen(false);
                            }}
                            className="text-muted-foreground"
                          >
                            <span className="text-sm">Clear selection</span>
                          </CommandItem>
                        )}
                        {brandFormats.map((f) => (
                          <CommandItem
                            key={f}
                            value={f}
                            onSelect={() => {
                              setFormat(f);
                              void persistField({ format: f });
                              setFormatPickerOpen(false);
                            }}
                            data-checked={format === f ? "true" : undefined}
                          >
                            <span className="text-sm">{f}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                const prev = status;
                const next = v ?? "";
                if (next === prev) return;
                setStatus(next);
                void persistField({ status: next || null }).then((ok) => {
                  if (!ok) setStatus(prev);
                });
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select status…" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Pillar Content</Label>
            <PillarPicker
              brand={brand}
              excludeId={contentId}
              value={pillar}
              onChange={(next) => {
                setPillar(next);
                void persistField({ pillarContentItemId: next?.id ?? null });
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Source type</Label>
            <Select
              value={sourceType}
              onValueChange={(v) => {
                const next = v ?? "original";
                const prev = sourceType;
                if (next === prev) return;
                setSourceType(next);
                void persistField({ sourceType: next }).then((ok) => {
                  if (!ok) setSourceType(prev);
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">Original</SelectItem>
                <SelectItem value="repost">Repost</SelectItem>
                <SelectItem value="cross_post">Cross-post</SelectItem>
              </SelectContent>
            </Select>
            {(sourceType === "repost" || sourceType === "cross_post") && (
              <p className="text-xs text-muted-foreground">
                Exempt from the (pillar, format) uniqueness — can reuse the
                original&rsquo;s format.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Producer</Label>
            <Select
              value={producerUserId || "__unassigned"}
              onValueChange={(v) => {
                const next = v && v !== "__unassigned" ? v : "";
                setProducerUserId(next);
                void persistField({ producerUserId: next || null });
              }}
            >
              <SelectTrigger className="[&>span]:flex [&>span]:items-center [&>span]:min-w-0 [&>span]:flex-1">
                {producerUser ? (
                  <UserChip user={producerUser} />
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned">Unassigned</SelectItem>
                {assignableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <UserChip user={u} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Editor</Label>
            <Select
              value={editorUserId || "__unassigned"}
              onValueChange={(v) => {
                const next = v && v !== "__unassigned" ? v : "";
                setEditorUserId(next);
                void persistField({ editorUserId: next || null });
              }}
            >
              <SelectTrigger className="[&>span]:flex [&>span]:items-center [&>span]:min-w-0 [&>span]:flex-1">
                {editorUser ? (
                  <UserChip user={editorUser} />
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned">Unassigned</SelectItem>
                {assignableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <UserChip user={u} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Published Link</Label>
            <Input
              value={publishedLink}
              onChange={(e) => setPublishedLink(e.target.value)}
              onBlur={() => {
                if ((item.publishedLink ?? "") !== publishedLink)
                  void persistField({ publishedLink: publishedLink || null });
              }}
              placeholder="https://…"
              disabled={isYouTube}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Published Date</Label>
            <Input
              type="date"
              value={publishedDate}
              onChange={(e) => {
                const next = e.target.value;
                setPublishedDate(next);
                if ((item.publishedDate ?? "") !== next)
                  void persistField({ publishedDate: next });
              }}
              disabled={isYouTube}
            />
          </div>
        </div>

        {deleteError && (
          <div className="text-sm rounded-lg px-3 py-2 bg-red-50 text-red-700 border border-red-200">
            {deleteError}
          </div>
        )}
      </div>

      {isPrePublish && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Instructions
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {currentFormat
                  ? `Instructions for creating "${currentFormat.name}" content.`
                  : "Instructions for creating this content."}
              </p>
            </div>
            {currentFormat && (
              <Link
                href={`/${brand}/formats/${currentFormat.id}`}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Edit
              </Link>
            )}
          </div>
          {formatPrompt ? (
            <div className="whitespace-pre-wrap break-words text-sm text-foreground bg-accent/30 rounded-md p-3 max-h-[600px] overflow-auto">
              {renderInstructions(formatPrompt)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {currentFormat
                ? "No prompt set on this format yet."
                : "This post has no format assigned."}
              {currentFormat && (
                <>
                  {" "}
                  <Link
                    href={`/${brand}/formats/${currentFormat.id}`}
                    className="text-foreground underline"
                  >
                    Add one
                  </Link>
                  .
                </>
              )}
            </div>
          )}
        </div>
      )}
      </div>

      <ContentActivity contentId={item.id} refreshKey={activityRefreshKey} />

      {!isPrePublish && (
      <>
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
              Every descendant — direct children, grandchildren, and deeper —
              across every status and format.
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
                          {d.depth > 1 && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-accent text-muted-foreground border border-border shrink-0"
                              title={
                                d.depth === 2
                                  ? "Grandchild"
                                  : d.depth === 3
                                  ? "Great-grandchild"
                                  : `${d.depth} levels deep`
                              }
                            >
                              L{d.depth}
                            </span>
                          )}
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

      {/* Reposts — list of same-content reposts that descend from this item.
          Styled to mirror the Derivative content table directly above so the
          two sections read as siblings. */}
      {data.reposts.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Reposts
                <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                  {data.reposts.length}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Same-content reposts of this piece over time.
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
                {data.reposts.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                  >
                    <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                      <div className="flex items-center gap-3">
                        {r.thumbnail && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={r.thumbnail}
                            alt=""
                            className="w-20 h-12 rounded object-cover shrink-0"
                          />
                        )}
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm font-medium text-foreground truncate inline-flex items-center gap-1.5">
                            <Link
                              href={`/${brand}/content/${r.id}`}
                              className="hover:text-primary hover:underline transition-colors truncate"
                            >
                              {r.title || "(Untitled)"}
                            </Link>
                            {r.publishedLink && (
                              <a
                                href={r.publishedLink}
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
                        {r.platform?.map((p) => (
                          <span
                            key={p}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.status ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border">
                          {r.status}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                      {r.publishedDate ? formatDate(r.publishedDate) : "-"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.views != null ? (
                        <span
                          title={
                            r.viewsEstimated ? "Estimated from likes" : undefined
                          }
                        >
                          {r.viewsEstimated ? "~" : ""}
                          {r.views.toLocaleString()}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.likes?.toLocaleString() || "-"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.comments?.toLocaleString() || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cross-posts — same content, different platform. Mirrors the Reposts
          table so the two sections read as siblings. */}
      {data.crossPosts.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Cross-posts
                <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                  {data.crossPosts.length}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Same content syndicated to other platforms.
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
                {data.crossPosts.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                  >
                    <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                      <div className="flex items-center gap-3">
                        {r.thumbnail && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={r.thumbnail}
                            alt=""
                            className="w-20 h-12 rounded object-cover shrink-0"
                          />
                        )}
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm font-medium text-foreground truncate inline-flex items-center gap-1.5">
                            <Link
                              href={`/${brand}/content/${r.id}`}
                              className="hover:text-primary hover:underline transition-colors truncate"
                            >
                              {r.title || "(Untitled)"}
                            </Link>
                            {r.publishedLink && (
                              <a
                                href={r.publishedLink}
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
                        {r.platform?.map((p) => (
                          <span
                            key={p}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.status ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border">
                          {r.status}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                      {r.publishedDate ? formatDate(r.publishedDate) : "-"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.views != null ? (
                        <span
                          title={
                            r.viewsEstimated ? "Estimated from likes" : undefined
                          }
                        >
                          {r.viewsEstimated ? "~" : ""}
                          {r.views.toLocaleString()}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.likes?.toLocaleString() || "-"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                      {r.comments?.toLocaleString() || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Repurpose to format */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Repurpose to format
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Claude reads each target format&apos;s skill, creates a Notion
              task for the editor, and fires a Descript clip if the skill
              calls for one.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {repurposeTargets.length > 0 && (
              <button
                type="button"
                onClick={() => repurposeAll(repurposeTargets.map((f) => f.id))}
                disabled={repurposingAll}
                title="Run Repurpose on every target format, one after another."
                className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {repurposingAll ? "Repurposing all…" : "Repurpose all"}
              </button>
            )}
          </div>
        </div>

        {!hasDescriptProject && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex items-center justify-between gap-3 flex-wrap">
            <span>
              This post doesn&apos;t have a Descript project. Clip-style
              formats will fall back to manual Notion tasks until you add one.
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
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {repurposeTargets.map((f) => {
              const st = clipStatus[f.id];
              const busy = st?.state === "running";
              const directiveText =
                st?.kind === "manual_task" ? st.guidance : st?.descriptPrompt;
              const showDirective =
                (st?.state === "previewed" ||
                  st?.state === "clipped" ||
                  st?.state === "created") &&
                !!directiveText;
              const hasDetails =
                showDirective ||
                st?.state === "clipped" ||
                st?.state === "created" ||
                st?.state === "error";
              return (
                <div key={f.id} className="px-3 py-2 bg-card">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/${brand}/formats/${f.id}`}
                        className="text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors"
                        title="Edit this format's skill / prompt"
                      >
                        {f.name}
                      </Link>
                      {st?.label && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent text-muted-foreground border border-border">
                          {st.label}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        type="button"
                        onClick={() => callRepurpose(f.id, "preview")}
                        disabled={busy || repurposingAll}
                        title="Ask Claude what it would do — no Notion or Descript writes."
                        className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy && st?.firedAt === "preview"
                          ? "Dry running…"
                          : "Dry run"}
                      </button>
                      <button
                        type="button"
                        onClick={() => callRepurpose(f.id, "real")}
                        disabled={busy || repurposingAll}
                        title="Creates a Notion task and, for clip-style skills, fires the Descript job."
                        className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy && st?.firedAt === "real"
                          ? "Repurposing…"
                          : "Repurpose →"}
                      </button>
                    </div>
                  </div>
                  {hasDetails && (
                    <div className="mt-2 space-y-1.5">
                      {showDirective && (
                        <div className="text-[11px] text-muted-foreground bg-muted/40 border border-border rounded-md p-2 whitespace-pre-wrap font-mono">
                          {directiveText}
                        </div>
                      )}
                      {(st?.state === "clipped" || st?.state === "created") && (
                        <div className="flex items-center gap-3 flex-wrap">
                          {st.state === "clipped" && st.projectUrl && (
                            <a
                              href={st.projectUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-primary hover:underline"
                            >
                              Open in Descript →
                            </a>
                          )}
                        </div>
                      )}
                      {st?.state === "error" && (
                        <p className="text-[11px] text-destructive">
                          {st.message}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium">Dry run</span> asks Claude (Haiku) what it would do — no writes.{" "}
          <span className="font-medium">Repurpose</span> creates the Notion task and, for clip-style skills, fires the Descript job. Click a format name to edit its skill.
        </p>
      </div>

      </>
      )}

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
                      Uploading to S3… {descriptProgress}%
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
        </DialogContent>
      </Dialog>

    </div>
  );
}
