"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

interface BrandFormat {
  id: string;
  name: string;
  contentType: string | null;
  descriptClipPrompt: string | null;
}

interface DetailResponse {
  item: ProductionItem;
  related: ProductionItem[];
  formatNames: string[];
  formats: BrandFormat[];
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

  // Per-format clip-out state, keyed by format id
  const [clipStatus, setClipStatus] = useState<
    Record<
      string,
      { state: "running" | "done" | "error"; message?: string; projectUrl?: string }
    >
  >({});

  async function clipOutTo(targetFormatId: string) {
    setClipStatus((prev) => ({ ...prev, [targetFormatId]: { state: "running" } }));
    try {
      const res = await fetch("/api/descript/clip-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: contentId,
          targetFormatId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setClipStatus((prev) => ({
          ...prev,
          [targetFormatId]: { state: "error", message: json.error || `HTTP ${res.status}` },
        }));
        return;
      }
      setClipStatus((prev) => ({
        ...prev,
        [targetFormatId]: {
          state: "done",
          message: `Clip queued (${json.window?.startSec ?? "?"}s–${json.window?.endSec ?? "?"}s)`,
          projectUrl: json.projectUrl,
        },
      }));
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

  function togglePlatform(p: string) {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }

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

  const { item, related, formatNames, formats: brandFormatDetails } = data;
  const brandFormats = formatNames;
  const isYouTube = !!item.youtubeId;

  const repurposeTargets = brandFormatDetails.filter(
    (f) => f.contentType === "repurposed"
  );
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
        {item.publishedLink && (
          <a
            href={item.publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View published ↗
          </a>
        )}
      </div>

      {/* Metrics */}
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
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            This post doesn&apos;t have a Descript project yet. Open it on its format page
            and use <span className="font-medium">Add to Descript</span> first, then the
            clip-out buttons here will work.
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
          <div className="flex flex-wrap gap-2">
            {repurposeTargets.map((f) => {
              const st = clipStatus[f.id];
              const hasCustomPrompt = !!f.descriptClipPrompt?.trim();
              const disabled = !hasDescriptProject || st?.state === "running";
              return (
                <div key={f.id} className="flex flex-col gap-1">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => clipOutTo(f.id)}
                    title={
                      hasCustomPrompt
                        ? "Uses this format's custom Descript prompt"
                        : "Uses the default Descript prompt"
                    }
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border bg-card text-sm hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        hasCustomPrompt ? "bg-purple-500" : "bg-border"
                      }`}
                    />
                    <span className="text-foreground">{f.name}</span>
                    {st?.state === "running" && (
                      <span className="text-xs text-muted-foreground">· clipping…</span>
                    )}
                    {st?.state === "done" && (
                      <span className="text-xs text-primary">· queued</span>
                    )}
                    {st?.state === "error" && (
                      <span className="text-xs text-destructive">· failed</span>
                    )}
                  </button>
                  {st?.state === "error" && (
                    <span className="text-[10px] text-destructive">{st.message}</span>
                  )}
                  {st?.state === "done" && (
                    <span className="text-[10px] text-muted-foreground">{st.message}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Purple dot = format has a custom Descript clip prompt. Grey dot = default prompt
          will be used.
        </p>
      </div>

      {/* Edit form */}
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

        <div className="space-y-2">
          <Label>Platform</Label>
          <div className="flex flex-wrap gap-2">
            {platformOptions.map((p) => (
              <Badge
                key={p}
                variant={platforms.includes(p) ? "default" : "outline"}
                className={isYouTube ? "" : "cursor-pointer"}
                onClick={() => {
                  if (!isYouTube) togglePlatform(p);
                }}
              >
                {p}
              </Badge>
            ))}
          </div>
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

      {/* Other platforms */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            Other platforms
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Other posts with this same title.
          </p>
        </div>
        {related.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            This post isn&apos;t cross-posted anywhere else.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-5 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
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
                    Comments
                  </th>
                </tr>
              </thead>
              <tbody>
                {related.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/50 last:border-b-0 hover:bg-accent/30"
                  >
                    <td className="px-5 py-2.5">
                      <Link
                        href={`/${brand}/content/${r.id}`}
                        className="text-foreground hover:underline"
                      >
                        {(r.platform || []).join(", ") || "—"}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
                      {formatDate(r.publishedDate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span
                        className={
                          r.viewsEstimated
                            ? "text-muted-foreground"
                            : "text-foreground"
                        }
                      >
                        {formatCompact(r.views)}
                        {r.viewsEstimated && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            est
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatCompact(r.likes)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatCompact(r.comments)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
