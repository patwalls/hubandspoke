"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { PlatformIcon } from "@/components/ui/platform-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Compact 1.2K / 48.2M number formatter. Falls back to — when null. */
function formatCount(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

interface AccountRow {
  id: string;
  brandSlug: string;
  brandLabel: string;
  platform: string;
  handle: string;
  displayName: string | null;
  url: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  totalViews: number | null;
  verified: boolean | null;
  location: string | null;
  isActive: boolean;
  syncedFromNotion: boolean;
  lastRefreshedAt: string | null;
  lastRefreshError: string | null;
  lastContentSyncAt: string | null;
  lastContentSyncError: string | null;
  /** Whether this platform has an SC content-list endpoint we can pull
   *  from. `x` and `threads` are `true` but only support latest mode. */
  syncSupported: boolean;
  /** Whether this platform supports historical backfill via SC pagination. */
  backfillSupported: boolean;
  /** Live count of production items tagged to this account (excluding
   *  soft-deleted items). Drives the Content column and the "this will
   *  delete N pieces of content" line in the delete confirmation. */
  contentCount: number;
  /** Zernio ConnectedAccount id for TikTok posting. Null = not connected.
   *  Only meaningful for platform='tiktok' accounts. */
  zernioAccountId: string | null;
}

interface BrandOption {
  slug: string;
  label: string;
}

const PLATFORM_OPTIONS = [
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "x", label: "X" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "threads", label: "Threads" },
  { value: "snapchat", label: "Snapchat" },
  { value: "newsletter", label: "Newsletter" },
  { value: "other", label: "Other" },
];

export function AccountsSettingsContent({
  accounts,
  brands,
  scopeBrandSlug = null,
  hideHeader = false,
}: {
  accounts: AccountRow[];
  brands: BrandOption[];
  /** If set, hide the grouped brand header, show only this brand's rows,
   *  and lock the Add-account form's brand selector. */
  scopeBrandSlug?: string | null;
  /** Hide the top "Accounts" title/description block (the Add-account
   *  button moves inline with the section). Use when the enclosing page
   *  already owns a page-level header. */
  hideHeader?: boolean;
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHandle, setEditHandle] = useState("");
  const [editPlatform, setEditPlatform] = useState("youtube");
  const [error, setError] = useState<string | null>(null);
  // Delete-confirmation dialog state. `deleteTarget` is the row the dialog
  // is confirming against (null = closed); `deleteConfirm` is the user's
  // in-progress typing that must equal the row's handle before Delete unlocks.
  const [deleteTarget, setDeleteTarget] = useState<AccountRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const scopedAccounts = scopeBrandSlug
    ? accounts.filter((a) => a.brandSlug === scopeBrandSlug)
    : accounts;

  // New-account form
  const [newBrand, setNewBrand] = useState(
    scopeBrandSlug ?? brands[0]?.slug ?? ""
  );
  const [newPlatform, setNewPlatform] = useState("youtube");
  const [newHandle, setNewHandle] = useState("");

  async function handleAdd() {
    if (!newBrand || !newHandle.trim()) {
      setError("Brand and handle are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brandSlug: newBrand,
          platform: newPlatform,
          handle: newHandle.trim(),
        }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setNewHandle("");
      setShowAdd(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(a: AccountRow) {
    setEditingId(a.id);
    setEditHandle(a.handle);
    setEditPlatform(a.platform);
    setError(null);
  }

  async function saveEdit(accountId: string) {
    const handle = editHandle.trim().replace(/^@/, "");
    if (!handle) {
      setError("Handle cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, platform: editPlatform }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setEditingId(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function openDelete(a: AccountRow) {
    setDeleteTarget(a);
    setDeleteConfirm("");
    setError(null);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteConfirm.trim() !== deleteTarget.handle) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmHandle: deleteTarget.handle }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setDeleteTarget(null);
      setDeleteConfirm("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  async function handleRefresh(accountId: string) {
    setRefreshingId(accountId);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshingId(null);
    }
  }

  /**
   * Enqueue a per-account content sync. `mode=latest` is one SC page — cheap
   * and idempotent. `mode=backfill` paginates back up to 50 pages on the
   * supported platforms (YouTube / IG / TikTok / LinkedIn). Always async —
   * the worker picks it up within ~1ms and the UI surfaces the new
   * `lastContentSyncAt` on the next router refresh.
   */
  async function handleSync(
    accountId: string,
    mode: "latest" | "backfill" = "latest"
  ) {
    setSyncingId(accountId);
    setError(null);
    try {
      const res = await fetch(
        `/api/accounts/${accountId}/sync-content?mode=${mode}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      // Give the worker a beat to at least start, then refresh the row.
      setTimeout(() => router.refresh(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to queue sync");
    } finally {
      setSyncingId(null);
    }
  }

  const byBrand = new Map<string, AccountRow[]>();
  for (const a of scopedAccounts) {
    if (!byBrand.has(a.brandLabel)) byBrand.set(a.brandLabel, []);
    byBrand.get(a.brandLabel)!.push(a);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        {hideHeader ? (
          <div />
        ) : (
          <div>
            <h2 className="text-base font-semibold text-foreground">Accounts</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Social accounts that production items get tagged to. Scrape Creators
              refresh pulls follower counts and avatars weekly.
            </p>
          </div>
        )}
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "Add account"}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="new-brand">Brand</Label>
              <select
                id="new-brand"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-60"
                value={newBrand}
                onChange={(e) => setNewBrand(e.target.value)}
                disabled={scopeBrandSlug != null}
              >
                {brands.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="new-platform">Platform</Label>
              <select
                id="new-platform"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                value={newPlatform}
                onChange={(e) => setNewPlatform(e.target.value)}
              >
                {PLATFORM_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="new-handle">
                {newPlatform === "linkedin" ? "Company page URL" : "Handle"}
              </Label>
              <Input
                id="new-handle"
                className="mt-1"
                placeholder={
                  newPlatform === "linkedin"
                    ? "linkedin.com/company/your-company"
                    : "starterstory"
                }
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
              />
              {newPlatform === "linkedin" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste the company&rsquo;s public URL (vanity slug, not the
                  numeric admin URL). Only company pages sync posts.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleteTarget ? `Delete @${deleteTarget.handle}?` : "Delete account?"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget ? (
                <>
                  This will soft-delete this account and all{" "}
                  <strong className="text-foreground">
                    {deleteTarget.contentCount.toLocaleString()}
                  </strong>{" "}
                  {deleteTarget.contentCount === 1 ? "piece" : "pieces"} of
                  content linked to it. The rows stay in the database and can
                  be restored by an engineer, but they will disappear from
                  every page of the app immediately.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="space-y-2">
              <Label htmlFor="delete-confirm">
                Type{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {deleteTarget.handle}
                </code>{" "}
                to confirm:
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={deleteTarget.handle}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteConfirm("");
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={
                deleting ||
                !deleteTarget ||
                deleteConfirm.trim() !== deleteTarget.handle
              }
            >
              {deleting ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {Array.from(byBrand.entries()).map(([brandLabel, rows]) => (
        <section key={brandLabel} className="space-y-2">
          {scopeBrandSlug == null && (
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              {brandLabel}
            </h3>
          )}
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full min-w-[1200px] text-sm">
              <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2" />
                  <th className="text-left px-3 py-2">Platform</th>
                  <th className="text-left px-3 py-2">Handle</th>
                  <th className="text-left px-3 py-2">Display name</th>
                  <th className="text-right px-3 py-2" title="Followers / subscribers">
                    Followers
                  </th>
                  <th className="text-right px-3 py-2" title="Following / friends / connections">
                    Following
                  </th>
                  <th className="text-right px-3 py-2" title="Posts / videos / tweets">
                    Posts
                  </th>
                  <th
                    className="text-right px-3 py-2"
                    title="Production items in Hub & Spoke tagged to this account"
                  >
                    Content
                  </th>
                  <th
                    className="text-right px-3 py-2"
                    title="Lifetime channel / profile views (YouTube, Threads)"
                  >
                    Views
                  </th>
                  <th className="text-left px-3 py-2">Last refresh</th>
                  <th
                    className="text-left px-3 py-2"
                    title="When this account's posts were last pulled from Scrape Creators"
                  >
                    Last sync
                  </th>
                  <th className="text-right px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <AccountAvatar
                        avatarUrl={a.avatarUrl}
                        platform={a.platform}
                        handle={a.handle}
                        size={32}
                        withPlatformBadge={false}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {editingId === a.id ? (
                        <select
                          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                          value={editPlatform}
                          onChange={(e) => setEditPlatform(e.target.value)}
                        >
                          {PLATFORM_OPTIONS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <PlatformIcon
                            platform={a.platform}
                            size={13}
                            className="text-muted-foreground shrink-0"
                          />
                          {a.platform}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingId === a.id ? (
                        <Input
                          className="h-7 w-40"
                          value={editHandle}
                          onChange={(e) => setEditHandle(e.target.value)}
                          placeholder="handle"
                          autoFocus
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          @{a.handle}
                          {a.verified && (
                            <span
                              title="Platform-verified"
                              className="text-blue-600 text-[11px]"
                            >
                              ✓
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <div className="flex flex-col gap-0.5">
                        <span>
                          {a.displayName ?? "—"}
                          {a.syncedFromNotion && (
                            <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-800">
                              Notion
                            </span>
                          )}
                          {!a.isActive && (
                            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-700">
                              inactive
                            </span>
                          )}
                        </span>
                        {a.location && (
                          <span className="text-[11px] text-muted-foreground">
                            {a.location}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right px-3 py-2 text-muted-foreground tabular-nums">
                      {formatCount(a.followerCount)}
                    </td>
                    <td className="text-right px-3 py-2 text-muted-foreground tabular-nums">
                      {formatCount(a.followingCount)}
                    </td>
                    <td className="text-right px-3 py-2 text-muted-foreground tabular-nums">
                      {formatCount(a.postCount)}
                    </td>
                    <td className="text-right px-3 py-2 text-muted-foreground tabular-nums">
                      {formatCount(a.contentCount)}
                    </td>
                    <td className="text-right px-3 py-2 text-muted-foreground tabular-nums">
                      {formatCount(a.totalViews)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {a.lastRefreshError ? (
                        <span className="text-red-600" title={a.lastRefreshError}>
                          error
                        </span>
                      ) : a.lastRefreshedAt ? (
                        new Date(a.lastRefreshedAt).toLocaleDateString()
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {a.lastContentSyncError ? (
                        <span
                          className="text-red-600"
                          title={a.lastContentSyncError}
                        >
                          error
                        </span>
                      ) : a.lastContentSyncAt ? (
                        new Date(a.lastContentSyncAt).toLocaleDateString()
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className="text-right px-3 py-2">
                      {editingId === a.id ? (
                        <div className="inline-flex gap-1">
                          <Button
                            size="sm"
                            disabled={saving}
                            onClick={() => saveEdit(a.id)}
                          >
                            {saving ? "..." : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => startEdit(a)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={refreshingId === a.id || a.platform === "newsletter" || a.platform === "snapchat" || a.platform === "other"}
                            onClick={() => handleRefresh(a.id)}
                            title="Refresh profile metadata (followers, avatar, bio)"
                          >
                            {refreshingId === a.id ? "..." : "Refresh"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={syncingId === a.id || !a.syncSupported}
                            onClick={() => handleSync(a.id, "latest")}
                            title={
                              a.syncSupported
                                ? "Pull the latest page of posts from Scrape Creators"
                                : "Scrape Creators has no content-list endpoint for this platform"
                            }
                          >
                            {syncingId === a.id ? "..." : "Sync"}
                          </Button>
                          {a.backfillSupported && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={syncingId === a.id}
                              onClick={() => handleSync(a.id, "backfill")}
                              title="Paginate back through the full catalog (up to 50 SC credits)"
                            >
                              Backfill
                            </Button>
                          )}
                          {a.platform === "tiktok" && (
                            <Button
                              size="sm"
                              variant={a.zernioAccountId ? "ghost" : "outline"}
                              onClick={() => {
                                window.location.href = `/api/integrations/zernio/connect?accountId=${a.id}`;
                              }}
                              title={
                                a.zernioAccountId
                                  ? "TikTok is connected for draft posting. Click to reconnect."
                                  : "Connect this TikTok account so Hub & Spoke can send drafts to its inbox"
                              }
                            >
                              {a.zernioAccountId ? "TikTok ✓" : "Connect TikTok"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => openDelete(a)}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
