"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Compact 1.2K / 48.2M number formatter. Falls back to — when null. */
function formatCount(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

/** Round avatar. Falls back to a colored dot with the platform's first
 *  letter when SC hasn't given us an image URL yet (e.g. un-refreshed
 *  account). Kept local to this component to avoid growing a cross-cutting
 *  Avatar primitive with per-platform fallback colors. */
function AccountAvatar({
  account,
}: {
  account: { avatarUrl: string | null; handle: string; platform: string };
}) {
  const [errored, setErrored] = useState(false);
  if (account.avatarUrl && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={account.avatarUrl}
        alt=""
        onError={() => setErrored(true)}
        className="size-8 rounded-full object-cover bg-muted shrink-0"
      />
    );
  }
  const initial = (account.handle[0] ?? "?").toUpperCase();
  return (
    <span className="size-8 rounded-full bg-muted text-muted-foreground text-xs font-medium flex items-center justify-center shrink-0">
      {initial}
    </span>
  );
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
  { value: "newsletter", label: "Newsletter" },
  { value: "other", label: "Other" },
];

export function AccountsSettingsContent({
  accounts,
  brands,
}: {
  accounts: AccountRow[];
  brands: BrandOption[];
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-account form
  const [newBrand, setNewBrand] = useState(brands[0]?.slug ?? "");
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

  const byBrand = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    if (!byBrand.has(a.brandLabel)) byBrand.set(a.brandLabel, []);
    byBrand.get(a.brandLabel)!.push(a);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Accounts</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Social accounts that production items get tagged to. Scrape Creators
            refresh pulls follower counts and avatars weekly.
          </p>
        </div>
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
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                value={newBrand}
                onChange={(e) => setNewBrand(e.target.value)}
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
              <Label htmlFor="new-handle">Handle</Label>
              <Input
                id="new-handle"
                className="mt-1"
                placeholder="starterstory"
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {Array.from(byBrand.entries()).map(([brandLabel, rows]) => (
        <section key={brandLabel} className="space-y-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            {brandLabel}
          </h3>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
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
                    title="Lifetime channel / profile views (YouTube, Threads)"
                  >
                    Views
                  </th>
                  <th className="text-left px-3 py-2">Last refresh</th>
                  <th className="text-right px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <AccountAvatar account={a} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{a.platform}</td>
                    <td className="px-3 py-2">
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
                    <td className="text-right px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={refreshingId === a.id || a.platform === "newsletter" || a.platform === "other"}
                        onClick={() => handleRefresh(a.id)}
                      >
                        {refreshingId === a.id ? "..." : "Refresh"}
                      </Button>
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
