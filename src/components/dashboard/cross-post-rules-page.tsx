"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CrossPostRule {
  id: string;
  brand: string;
  sourcePlatform: string;
  viewThreshold: number;
  targetPlatform: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  brand: string;
  brandLabel: string;
  channels: string[];
}

export function CrossPostRulesPageContent({
  brand,
  brandLabel,
  channels,
}: Props) {
  const [rules, setRules] = useState<CrossPostRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New-rule form
  const [sourcePlatform, setSourcePlatform] = useState(channels[0] ?? "");
  const [targetPlatform, setTargetPlatform] = useState(channels[1] ?? "");
  const [viewThreshold, setViewThreshold] = useState("10000");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cross-post-rules?brand=${brand}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rules: CrossPostRule[] };
      setRules(json.rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load rules");
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    load();
  }, [load]);

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const n = Number(viewThreshold);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error("Threshold must be a non-negative whole number");
      }
      if (sourcePlatform === targetPlatform) {
        throw new Error("Source and target platforms must differ");
      }
      const res = await fetch("/api/cross-post-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          sourcePlatform,
          targetPlatform,
          viewThreshold: n,
          active: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: CrossPostRule) {
    setError(null);
    try {
      const res = await fetch(`/api/cross-post-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !rule.active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle");
    }
  }

  async function updateThreshold(rule: CrossPostRule, value: string) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return;
    if (n === rule.viewThreshold) return;
    setError(null);
    try {
      const res = await fetch(`/api/cross-post-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewThreshold: n }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function remove(rule: CrossPostRule) {
    if (
      !confirm(
        `Delete rule: ${rule.sourcePlatform} ≥ ${rule.viewThreshold.toLocaleString()} → ${rule.targetPlatform}?`
      )
    )
      return;
    setError(null);
    try {
      const res = await fetch(`/api/cross-post-rules/${rule.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
          Cross-post rules
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          {brandLabel} — when a published post on the source platform hits the
          view threshold, a cross-post idea is auto-queued for the target
          platform.
        </p>
      </div>

      <form
        onSubmit={addRule}
        className="rounded-lg border border-border bg-card p-5 space-y-4"
      >
        <h2 className="text-base font-semibold text-foreground">
          Add a rule
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_1fr] gap-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="source-platform">Source platform</Label>
            <select
              id="source-platform"
              value={sourcePlatform}
              onChange={(e) => setSourcePlatform(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm"
            >
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="view-threshold">Views ≥</Label>
            <Input
              id="view-threshold"
              type="number"
              inputMode="numeric"
              min={0}
              step={100}
              value={viewThreshold}
              onChange={(e) => setViewThreshold(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="target-platform">Target platform</Label>
            <select
              id="target-platform"
              value={targetPlatform}
              onChange={(e) => setTargetPlatform(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm"
            >
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Adding…" : "Add rule"}
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </form>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold text-foreground">Rules</h2>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground px-5 py-6">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground px-5 py-6">
            No rules yet. Add one above.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-accent/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-5 py-2 font-medium">Source</th>
                <th className="text-left px-5 py-2 font-medium">Threshold</th>
                <th className="text-left px-5 py-2 font-medium">Target</th>
                <th className="text-left px-5 py-2 font-medium">Active</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-t border-border">
                  <td className="px-5 py-2 text-foreground">
                    {rule.sourcePlatform}
                  </td>
                  <td className="px-5 py-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={100}
                      defaultValue={rule.viewThreshold}
                      onBlur={(e) => updateThreshold(rule, e.target.value)}
                      className="w-28 h-8 rounded-md border border-input bg-background px-2 text-sm"
                    />
                  </td>
                  <td className="px-5 py-2 text-foreground">
                    {rule.targetPlatform}
                  </td>
                  <td className="px-5 py-2">
                    <button
                      type="button"
                      onClick={() => toggleActive(rule)}
                      className={
                        rule.active
                          ? "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-100 text-emerald-800 border border-emerald-200"
                          : "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground border border-border"
                      }
                    >
                      {rule.active ? "Active" : "Paused"}
                    </button>
                  </td>
                  <td className="px-5 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(rule)}
                      className="text-sm text-red-600 hover:text-red-700"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
