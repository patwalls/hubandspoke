"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Mirror of ShortLink from lib/services/short-links, but redeclared here so
// the client component doesn't have to import a server-only module.
// `inUseCount` is augmented in by /api/short-links by joining against
// production_items.short_link_slug — tells us which slugs are already wired
// to a post so the picker can sort/mark them.
interface ShortLink {
  slug: string;
  destinationUrl: string;
  clicksCount: number;
  lastClickedAt: string | null;
  tag: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  inUseCount?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slug currently attached to this post, if any. */
  currentSlug: string | null;
  /** Base host for the redirect, e.g. "https://go.starterstory.com". */
  baseUrl: string;
  /** Called after a successful save so the parent can refresh its view.
   *  Receives the newly-attached slug (or null on detach). */
  onSaved: (slug: string | null) => Promise<void> | void;
}

type View = "loading" | "list" | "edit" | "new";

// Convention: only slugs tagged "dm" are actually wired to a ManyChat DM.
// Everything else (sponsor slugs, random redirects) is excluded from the picker
// so it doesn't get attached to a post that won't trigger a DM. The
// `/settings/links` admin page shows the whole pool; this picker does not.
const DM_TAG = "dm";

function formatLastClick(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

// Sort: archived to the bottom, then unused (not attached to any post) before
// in-use, then within each bucket never-clicked first (null sorts before
// everything), then least-recent. The primary "unused first" rule keeps fresh
// slugs at the top — the operator's most common need.
function staleSort(a: ShortLink, b: ShortLink): number {
  if (a.archived !== b.archived) return a.archived ? 1 : -1;
  const aInUse = (a.inUseCount ?? 0) > 0;
  const bInUse = (b.inUseCount ?? 0) > 0;
  if (aInUse !== bInUse) return aInUse ? 1 : -1;
  if (a.lastClickedAt === b.lastClickedAt) return a.slug.localeCompare(b.slug);
  if (a.lastClickedAt == null) return -1;
  if (b.lastClickedAt == null) return 1;
  return a.lastClickedAt.localeCompare(b.lastClickedAt);
}

export function AttachDmKeywordDialog({
  open,
  onOpenChange,
  currentSlug,
  baseUrl,
  onSaved,
}: Props) {
  const [view, setView] = useState<View>("loading");
  const [links, setLinks] = useState<ShortLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Active row being edited (existing slug path)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [destination, setDestination] = useState("");

  // New slug path
  const [newSlug, setNewSlug] = useState("");
  const [newDestination, setNewDestination] = useState("");

  // List filter
  const [filter, setFilter] = useState("");

  const loadLinks = useCallback(async () => {
    setView("loading");
    setError(null);
    try {
      const res = await fetch(`/api/short-links?include_archived=true&tag=${DM_TAG}`);
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { shortLinks: ShortLink[] };
      setLinks(payload.shortLinks);

      // If the post already has a slug attached, jump straight to edit view
      // prefilled with its current destination.
      if (currentSlug) {
        const existing = payload.shortLinks.find((l) => l.slug === currentSlug);
        if (existing) {
          setSelectedSlug(existing.slug);
          setDestination(existing.destinationUrl);
          setView("edit");
          return;
        }
      }
      setView("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load short links");
      setView("list");
    }
  }, [currentSlug]);

  // Fetch on every open so click counts + last_clicked_at stay fresh.
  useEffect(() => {
    if (!open) return;
    setSelectedSlug(null);
    setDestination("");
    setNewSlug("");
    setNewDestination("");
    setFilter("");
    setError(null);
    void loadLinks();
  }, [open, loadLinks]);

  const sortedFiltered = useMemo(() => {
    const filterLower = filter.trim().toLowerCase();
    const filtered = filterLower
      ? links.filter(
          (l) =>
            l.slug.includes(filterLower) ||
            (l.tag ?? "").toLowerCase().includes(filterLower),
        )
      : links;
    return [...filtered].sort(staleSort);
  }, [links, filter]);

  function selectSlug(link: ShortLink) {
    setSelectedSlug(link.slug);
    setDestination(link.destinationUrl);
    setError(null);
    setView("edit");
  }

  async function handleSaveExisting() {
    if (!selectedSlug) return;
    const trimmed = destination.trim();
    if (!isHttpsUrl(trimmed)) {
      setError("Destination must be an https:// URL");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 1) Update the destination in the short-link pool (no-op if unchanged).
      const existing = links.find((l) => l.slug === selectedSlug);
      if (existing && existing.destinationUrl !== trimmed) {
        const res = await fetch(`/api/short-links/${encodeURIComponent(selectedSlug)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationUrl: trimmed }),
        });
        if (!res.ok) {
          const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(msg ?? `HTTP ${res.status}`);
        }
      }
      // 2) Attach the slug to the post.
      await onSaved(selectedSlug);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateNew() {
    const slugValue = newSlug.trim().toLowerCase();
    const urlValue = newDestination.trim();
    if (!slugValue) {
      setError("Slug is required");
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(slugValue)) {
      setError("Slug: letters, numbers, hyphens, underscores only");
      return;
    }
    if (!isHttpsUrl(urlValue)) {
      setError("Destination must be an https:// URL");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/short-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: slugValue, destinationUrl: urlValue, tag: DM_TAG }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      await onSaved(slugValue);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDetach() {
    if (!window.confirm("Detach this slug from the post? The slug itself stays in the pool.")) return;
    setSaving(true);
    setError(null);
    try {
      await onSaved(null);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detach failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="!max-w-[min(1200px,95vw)] sm:!max-w-[min(1200px,95vw)] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {view === "edit"
              ? `DM keyword: ${selectedSlug}`
              : view === "new"
              ? "Create new slug"
              : "Attach DM keyword"}
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {view === "loading" && (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading short links…</div>
        )}

        {view === "list" && (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Pick a DM-keyword slug (tagged <code className="px-1 py-0.5 rounded bg-muted">{DM_TAG}</code>)
              from the pool. Unused slugs first; slugs already attached to
              another post are struck through and sink to the bottom — picking
              one moves it to this post. The DM sends{" "}
              <code className="px-1 py-0.5 rounded bg-muted">{baseUrl}/&lt;slug&gt;</code>.
              Sponsor slugs and other non-DM redirects are hidden from this list.
            </p>
            <Input
              placeholder="Filter by slug or tag…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
            <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Slug</th>
                    <th className="text-left px-3 py-2 w-24">Last click</th>
                    <th className="text-left px-3 py-2 w-16">Clicks</th>
                    <th className="text-left px-3 py-2">Currently points to</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-xs text-muted-foreground">
                        No matching slugs.
                      </td>
                    </tr>
                  ) : (
                    sortedFiltered.map((link) => {
                      const inUse = (link.inUseCount ?? 0) > 0;
                      return (
                        <tr
                          key={link.slug}
                          className="border-t border-border hover:bg-accent/40 cursor-pointer"
                          onClick={() => selectSlug(link)}
                        >
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <code
                                className={
                                  "text-xs px-1.5 py-0.5 rounded bg-muted" +
                                  (inUse ? " line-through text-muted-foreground" : "")
                                }
                              >
                                {link.slug}
                              </code>
                              {inUse && (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-800">
                                  in use{(link.inUseCount ?? 0) > 1 ? ` · ${link.inUseCount}` : ""}
                                </span>
                              )}
                              {link.archived && (
                                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-700">
                                  archived
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {formatLastClick(link.lastClickedAt)}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{link.clicksCount}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[260px]">
                            {link.destinationUrl}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex justify-between items-center pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setView("new")}
                disabled={saving}
              >
                + Create new slug
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {view === "edit" && selectedSlug && (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              <code className="px-1 py-0.5 rounded bg-muted">{baseUrl}/{selectedSlug}</code>{" "}
              will redirect to the URL below. Commenters who type{" "}
              <code className="px-1 py-0.5 rounded bg-muted">{selectedSlug.toUpperCase()}</code>{" "}
              on this post get DM&apos;d that link.
            </div>
            <div className="space-y-2">
              <Label htmlFor="dm-destination">Destination URL</Label>
              <Input
                id="dm-destination"
                type="url"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="https://starterstory.com/…"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                This is shared with every other post using the same slug.
                Changing it here changes it everywhere.
              </p>
            </div>
            <div className="flex justify-between pt-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedSlug(null);
                    setDestination("");
                    setView("list");
                  }}
                  disabled={saving}
                >
                  ← Pick different slug
                </Button>
                {currentSlug === selectedSlug && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={handleDetach}
                    disabled={saving}
                  >
                    Detach from post
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={handleSaveExisting} disabled={saving || !destination.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {view === "new" && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Creates a new slug in the pool. The redirect goes live immediately
              at <code className="px-1 py-0.5 rounded bg-muted">{baseUrl}/&lt;slug&gt;</code>.
            </p>
            <div className="space-y-2">
              <Label htmlFor="new-slug-input">Slug</Label>
              <Input
                id="new-slug-input"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="bootstrap"
                className="font-mono"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Lowercased on save. Letters, numbers, hyphens, underscores.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-destination-input">Destination URL</Label>
              <Input
                id="new-destination-input"
                type="url"
                value={newDestination}
                onChange={(e) => setNewDestination(e.target.value)}
                placeholder="https://starterstory.com/…"
              />
            </div>
            <div className="flex justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setView("list")}
                disabled={saving}
              >
                ← Back to list
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleCreateNew}
                  disabled={saving || !newSlug.trim() || !newDestination.trim()}
                >
                  {saving ? "Creating…" : "Create + attach"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function isHttpsUrl(value: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
