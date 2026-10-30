"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ApiKeySummary } from "@/lib/api/keys";
import { trackUsage } from "@/lib/usage/track";
import { CodeBlock } from "./code-block";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function ApiKeysPanel({
  isAdmin,
  onKeyCreated,
}: {
  isAdmin: boolean;
  /** The plaintext key, once — the quickstart fills it into its snippets. */
  onKeyCreated: (key: string) => void;
}) {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  // Bumping `reloadTick` refetches; the fetch itself lives in the effect so
  // state is only set from the response callback (react-hooks/set-state-in-effect).
  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/api-keys${showAll ? "?all=1" : ""}`, { cache: "no-store" });
      const body = res.ok ? ((await res.json()) as { keys: ApiKeySummary[] }) : { keys: [] };
      if (!cancelled) setKeys(body.keys);
    })().catch(() => {
      if (!cancelled) setKeys([]);
    });
    return () => {
      cancelled = true;
    };
  }, [showAll, reloadTick]);

  async function create() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expires_in_days: expiresDays || undefined }),
      });
      const body = (await res.json()) as { key?: string; summary?: ApiKeySummary; error?: string };
      if (!res.ok || !body.key || !body.summary) {
        setError(body.error ?? "Could not create the key.");
        return;
      }
      setCreated({ key: body.key, name: body.summary.name });
      onKeyCreated(body.key);
      trackUsage("developers:key-created");
      setName("");
      setExpiresDays("");
      load();
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    setConfirmRevoke(null);
    if (res.status === 204) {
      toast.success("Key revoked. Anything using it stops working now.");
      load();
    } else {
      toast.error("Could not revoke that key.");
    }
  }

  function closeDialog(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreated(null);
      setError(null);
    }
  }

  const active = (keys ?? []).filter((k) => !k.revokedAt);
  const revoked = (keys ?? []).filter((k) => k.revokedAt);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">API keys</h3>
          <p className="text-xs text-muted-foreground">
            A key acts as you: it can read everything you can see in the app. Name it after what will use it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="accent-primary"
              />
              Everyone&apos;s keys
            </label>
          ) : null}
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus data-icon="inline-start" /> Create key
          </Button>
        </div>
      </div>

      {keys === null ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
      ) : active.length === 0 && revoked.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <KeyRound className="size-6 text-muted-foreground" />
          <p className="text-sm text-foreground">No API keys yet.</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Create one to pull content and transcripts into a spreadsheet, a script, Zapier, or an AI assistant.
          </p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Key</th>
              {showAll ? <th className="px-4 py-2 font-medium">Owner</th> : null}
              <th className="px-4 py-2 font-medium">Last used</th>
              <th className="px-4 py-2 font-medium text-right">Requests</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {[...active, ...revoked].map((k) => (
              <tr key={k.id} className={`border-b border-border last:border-0 ${k.revokedAt ? "opacity-50" : ""}`}>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-foreground">{k.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {k.revokedAt
                      ? `Revoked ${relative(k.revokedAt)}`
                      : k.expiresAt
                        ? `Expires ${new Date(k.expiresAt).toLocaleDateString()}`
                        : `Created ${new Date(k.createdAt).toLocaleDateString()}`}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{k.keyPrefix}…</td>
                {showAll ? (
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{k.owner?.name ?? k.owner?.email ?? "—"}</td>
                ) : null}
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{relative(k.lastUsedAt)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{k.requestCount}</td>
                <td className="px-4 py-2.5 text-right">
                  {k.revokedAt ? null : confirmRevoke === k.id ? (
                    <span className="inline-flex items-center gap-1">
                      <Button size="xs" variant="destructive" onClick={() => revoke(k.id)}>
                        Confirm revoke
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(k.id)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-lg">
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Your new key: {created.name}</DialogTitle>
                <DialogDescription>
                  Copy it now. For your security it is shown once and cannot be recovered — you can always create another.
                </DialogDescription>
              </DialogHeader>
              <CodeBlock code={created.key} wrap />
              <p className="text-xs text-muted-foreground">
                Send it on every request as <code className="font-mono">Authorization: Bearer {"<key>"}</code>. The quickstart
                below is already filled in with it.
              </p>
              <DialogFooter>
                <Button onClick={() => closeDialog(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create an API key</DialogTitle>
                <DialogDescription>
                  Name it after what will use it so you know what to revoke later.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    autoFocus
                    placeholder="e.g. Zapier, Google Sheet, Claude Desktop"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && name.trim() && !submitting) void create();
                    }}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="api-key-expiry">Expires after (days, optional)</Label>
                  <Input
                    id="api-key-expiry"
                    inputMode="numeric"
                    placeholder="Leave empty for no expiry"
                    value={expiresDays}
                    onChange={(e) => setExpiresDays(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => closeDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={create} disabled={!name.trim() || submitting}>
                  {submitting ? "Creating…" : "Create key"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
