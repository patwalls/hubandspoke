"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SettingsPageContentProps {
  brand: string;
  brandLabel: string;
}

export function SettingsPageContent({
  brand,
  brandLabel,
}: SettingsPageContentProps) {
  const [weeklyGoal, setWeeklyGoal] = useState<string>("");
  const [savedGoal, setSavedGoal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "saved" }
    | { kind: "cleared" }
    | { kind: "error"; message: string }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/brand-settings?brand=${brand}`);
        const json = await res.json();
        if (cancelled) return;
        const goal: number | null = json?.weeklyGoal ?? null;
        setSavedGoal(goal);
        setWeeklyGoal(goal != null ? String(goal) : "");
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [brand]);

  async function persist(value: number | null) {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/brand-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, weeklyGoal: value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save");
      }
      const json = await res.json();
      const goal: number | null = json?.weeklyGoal ?? null;
      setSavedGoal(goal);
      setWeeklyGoal(goal != null ? String(goal) : "");
      setStatus({ kind: value == null ? "cleared" : "saved" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = weeklyGoal.trim();
    if (trimmed === "") {
      setStatus({ kind: "error", message: "Enter a number or use Clear goal." });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      setStatus({ kind: "error", message: "Goal must be a non-negative whole number." });
      return;
    }
    persist(n);
  }

  function handleClear() {
    persist(null);
  }

  const dirty =
    !loading &&
    weeklyGoal.trim() !== (savedGoal != null ? String(savedGoal) : "");

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
          Settings
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Configure {brandLabel}
        </p>
      </div>

      <form
        onSubmit={handleSave}
        className="rounded-lg border border-border bg-card p-5 space-y-4"
      >
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Production goals
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Used by the &ldquo;Production this week&rdquo; tile on the dashboard.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="weekly-goal">Weekly production goal</Label>
          <Input
            id="weekly-goal"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder="e.g. 77"
            value={weeklyGoal}
            onChange={(e) => {
              setWeeklyGoal(e.target.value);
              setStatus(null);
            }}
            disabled={loading || saving}
            className="max-w-[200px]"
          />
          <p className="text-xs text-muted-foreground">
            Posts per week target across all platforms. Leave blank and Clear to remove.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={saving || loading || !dirty}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
            disabled={saving || loading || savedGoal == null}
          >
            Clear goal
          </Button>
          {status?.kind === "saved" && (
            <span className="text-xs text-primary">Saved.</span>
          )}
          {status?.kind === "cleared" && (
            <span className="text-xs text-muted-foreground">Goal cleared.</span>
          )}
          {status?.kind === "error" && (
            <span className="text-xs text-amber-600">{status.message}</span>
          )}
        </div>
      </form>

      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Cross-post rules
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Auto-queue cross-post ideas when a post crosses a view threshold.
          </p>
        </div>
        <Link
          href={`/${brand}/cross-post-rules`}
          className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary hover:underline"
        >
          Manage rules
          <ExternalLinkIcon className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
