"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ShortLink } from "@/lib/services/short-links";

interface Props {
  initialLinks: ShortLink[];
  baseUrl: string;
  initialError: string | null;
}

function formatLastClick(iso: string | null): string {
  if (!iso) return "—";
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

export function ShortLinksSettings({ initialLinks, baseUrl, initialError }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [copied, setCopied] = useState<string | null>(null);

  // Inline edit state — slug of the row being edited
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editTag, setEditTag] = useState("");
  const [editArchived, setEditArchived] = useState(false);

  // New-link form
  const [showAdd, setShowAdd] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTag, setNewTag] = useState("");

  function openEdit(link: ShortLink) {
    setEditingSlug(link.slug);
    setEditUrl(link.destinationUrl);
    setEditTag(link.tag ?? "");
    setEditArchived(link.archived);
    setError(null);
  }

  async function handleSaveEdit(slug: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/short-links/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationUrl: editUrl.trim(),
          tag: editTag.trim() || null,
          archived: editArchived,
        }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setEditingSlug(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd() {
    if (!newSlug.trim() || !newUrl.trim()) {
      setError("slug and destination URL are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/short-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: newSlug.trim().toLowerCase(),
          destinationUrl: newUrl.trim(),
          tag: newTag.trim() || null,
        }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setNewSlug("");
      setNewUrl("");
      setNewTag("");
      setShowAdd(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add link");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(slug: string) {
    if (!window.confirm(`Delete short link "${slug}"? This removes it from the redirect service.`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/short-links/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete link");
    } finally {
      setSaving(false);
    }
  }

  async function copyUrl(slug: string) {
    const full = `${baseUrl}/${slug}`;
    try {
      await navigator.clipboard.writeText(full);
      setCopied(slug);
      setTimeout(() => setCopied((s) => (s === slug ? null : s)), 1500);
    } catch {
      setError("Clipboard write failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Short links</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Redirect slugs that the ManyChat IG-comment pool DMs back. Each slug
            resolves to{" "}
            <code className="text-xs px-1 py-0.5 rounded bg-muted">
              {baseUrl}/&lt;slug&gt;
            </code>
            . Clicks + last-click are pulled from the redirect service.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)} disabled={saving}>
          {showAdd ? "Cancel" : "+ Add link"}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="new-slug">Slug</Label>
              <Input
                id="new-slug"
                className="mt-1 font-mono"
                placeholder="bootstrap"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                autoFocus
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Lowercased on save. Letters, numbers, hyphen, underscore.
              </p>
            </div>
            <div>
              <Label htmlFor="new-tag">Tag (optional)</Label>
              <Input
                id="new-tag"
                className="mt-1"
                placeholder="manychat"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="new-url">Destination URL</Label>
            <Input
              id="new-url"
              type="url"
              className="mt-1"
              placeholder="https://starterstory.com/ideas"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {initialLinks.length === 0 && !error ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground text-center">
          No short links yet. Add one to get started.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Slug</th>
                <th className="text-left px-3 py-2">Destination</th>
                <th className="text-left px-3 py-2 w-20">Clicks</th>
                <th className="text-left px-3 py-2 w-24">Last click</th>
                <th className="text-left px-3 py-2 w-24">Tag</th>
                <th className="text-right px-3 py-2 w-52" />
              </tr>
            </thead>
            <tbody>
              {initialLinks.map((link) => {
                const isEditing = editingSlug === link.slug;
                return (
                  <tr key={link.slug} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <code className="text-xs px-1.5 py-0.5 rounded bg-muted">
                          {link.slug}
                        </code>
                        {link.archived && (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-700">
                            archived
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <div className="space-y-2">
                          <Input
                            value={editUrl}
                            onChange={(e) => setEditUrl(e.target.value)}
                            placeholder="https://…"
                          />
                          <Input
                            value={editTag}
                            onChange={(e) => setEditTag(e.target.value)}
                            placeholder="Tag (optional)"
                          />
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={editArchived}
                              onChange={(e) => setEditArchived(e.target.checked)}
                            />
                            Archived (hides from redirect — 302s to homepage fallback)
                          </label>
                        </div>
                      ) : (
                        <a
                          href={link.destinationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-foreground hover:underline break-all"
                        >
                          {link.destinationUrl}
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{link.clicksCount}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatLastClick(link.lastClickedAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {link.tag || "—"}
                    </td>
                    <td className="text-right px-3 py-2">
                      {isEditing ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingSlug(null)}
                            disabled={saving}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleSaveEdit(link.slug)}
                            disabled={saving}
                          >
                            {saving ? "…" : "Save"}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => copyUrl(link.slug)}
                          >
                            {copied === link.slug ? "Copied" : "Copy"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openEdit(link)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDelete(link.slug)}
                            disabled={saving}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
