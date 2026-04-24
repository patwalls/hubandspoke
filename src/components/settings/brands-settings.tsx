"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface BrandRow {
  id: string;
  slug: string;
  label: string;
  avatarUrl: string | null;
  color: string | null;
  disabled: boolean;
}

// Presets match the gradient classes shipped with the seed. Picking from a
// short list avoids users hand-typing Tailwind strings that don't render;
// the `custom` escape hatch lets advanced users drop in arbitrary classes.
const COLOR_PRESETS: Array<{ value: string; label: string }> = [
  { value: "from-emerald-500 to-emerald-700", label: "Emerald" },
  { value: "from-orange-500 to-rose-600", label: "Orange → Rose" },
  { value: "from-amber-500 to-yellow-600", label: "Amber → Yellow" },
  { value: "from-sky-500 to-indigo-600", label: "Sky → Indigo" },
  { value: "from-violet-500 to-purple-700", label: "Violet" },
  { value: "from-pink-500 to-rose-600", label: "Pink" },
  { value: "from-blue-500 to-cyan-600", label: "Blue → Cyan" },
  { value: "from-zinc-500 to-zinc-700", label: "Zinc" },
];

function BrandAvatar({ brand, size = 28 }: { brand: BrandRow; size?: number }) {
  const [errored, setErrored] = useState(false);
  const initials = brand.label
    .split(" ")
    .filter((w) => /[A-Za-z0-9]/.test(w[0] ?? ""))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  if (!errored && brand.avatarUrl) {
    return (
      <span
        className="relative shrink-0 inline-block rounded-full overflow-hidden bg-muted"
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={brand.avatarUrl}
          alt=""
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-full bg-gradient-to-br text-white font-semibold flex items-center justify-center select-none shrink-0",
        brand.color
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initials || "?"}
    </span>
  );
}

export function BrandsSettingsContent({ brands }: { brands: BrandRow[] }) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-brand form
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [color, setColor] = useState(COLOR_PRESETS[0].value);

  // Edit state — which brand is open, and its in-flight field values.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editAvatar, setEditAvatar] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editDisabled, setEditDisabled] = useState(false);

  async function handleAdd() {
    if (!slug.trim() || !label.trim()) {
      setError("slug and label are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/brands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          label: label.trim(),
          avatarUrl: avatarUrl.trim() || null,
          color: color || null,
        }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setSlug("");
      setLabel("");
      setAvatarUrl("");
      setShowAdd(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add brand");
    } finally {
      setSaving(false);
    }
  }

  function openEdit(brand: BrandRow) {
    setEditingId(brand.id);
    setEditLabel(brand.label);
    setEditAvatar(brand.avatarUrl ?? "");
    setEditColor(brand.color ?? COLOR_PRESETS[0].value);
    setEditDisabled(brand.disabled);
    setError(null);
  }

  async function handleSaveEdit(slug: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/brands/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: editLabel.trim(),
          avatarUrl: editAvatar.trim() || null,
          color: editColor || null,
          disabled: editDisabled,
        }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      setEditingId(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save brand");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleDisabled(slug: string, disabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/brands/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update brand");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Brands</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Workspaces that content rolls up under. Add a brand to make it
            show up in the top nav and as a filter option across the app.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "Add brand"}
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
                className="mt-1"
                placeholder="my-new-brand"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                URL path: /{slug || "…"}
              </p>
            </div>
            <div>
              <Label htmlFor="new-label">Label</Label>
              <Input
                id="new-label"
                className="mt-1"
                placeholder="My New Brand"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="new-avatar">Avatar URL</Label>
            <Input
              id="new-avatar"
              className="mt-1"
              placeholder="/brands/my-new-brand.jpg or https://…"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="new-color">Avatar color (fallback)</Label>
            <select
              id="new-color"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            >
              {COLOR_PRESETS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 w-12" />
              <th className="text-left px-3 py-2">Brand</th>
              <th className="text-left px-3 py-2">Slug</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-right px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const isEditing = editingId === b.id;
              return (
                <tr key={b.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <BrandAvatar brand={isEditing ? { ...b, label: editLabel, avatarUrl: editAvatar || null, color: editColor || null } : b} />
                  </td>
                  <td className="px-3 py-2">
                    {isEditing ? (
                      <div className="space-y-2">
                        <Input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          placeholder="Label"
                        />
                        <Input
                          value={editAvatar}
                          onChange={(e) => setEditAvatar(e.target.value)}
                          placeholder="Avatar URL (blank = initials fallback)"
                        />
                        <select
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                        >
                          {COLOR_PRESETS.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={editDisabled}
                            onChange={(e) => setEditDisabled(e.target.checked)}
                          />
                          Disabled (greyed out in nav, no new items)
                        </label>
                      </div>
                    ) : (
                      <div className="font-medium">{b.label}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {b.slug}
                  </td>
                  <td className="px-3 py-2">
                    {b.disabled ? (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-700">
                        disabled
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
                        active
                      </span>
                    )}
                  </td>
                  <td className="text-right px-3 py-2">
                    {isEditing ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingId(null)}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSaveEdit(b.slug)}
                          disabled={saving}
                        >
                          {saving ? "…" : "Save"}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {b.disabled && (
                          <Button
                            size="sm"
                            onClick={() => handleToggleDisabled(b.slug, false)}
                            disabled={saving}
                          >
                            Enable
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(b)}
                        >
                          Edit
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
    </div>
  );
}
