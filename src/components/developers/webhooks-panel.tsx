"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Webhook } from "lucide-react";
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
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, type WebhookEvent } from "@/lib/api/constants";
import type { ApiDelivery, ApiWebhook } from "@/lib/api/webhooks";
import { trackUsage } from "@/lib/usage/track";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

function errorMessage(body: unknown, fallback: string): string {
  const e = (body as { error?: { message?: string } })?.error;
  return e?.message ?? fallback;
}

export function WebhooksPanel({ isAdmin }: { isAdmin: boolean }) {
  const [hooks, setHooks] = useState<ApiWebhook[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(["content.published"]));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, ApiDelivery[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api<{ data: ApiWebhook[] }>(`/api/v1/webhooks${showAll ? "?all=1" : ""}`, { cache: "no-store" });
      if (!cancelled) setHooks(r.ok ? r.body.data : []);
    })().catch(() => {
      if (!cancelled) setHooks([]);
    });
    return () => {
      cancelled = true;
    };
  }, [showAll, reloadTick]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      const r = await api<{ data: ApiDelivery[] }>(`/api/v1/webhooks/${expanded}/deliveries?limit=20`, { cache: "no-store" });
      if (!cancelled && r.ok) setDeliveries((d) => ({ ...d, [expanded]: r.body.data }));
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, reloadTick]);

  async function create() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<{ data: ApiWebhook & { secret: string } }>("/api/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ name, url, events: [...events] }),
      });
      if (!r.ok) {
        setError(errorMessage(r.body, "Could not create the webhook."));
        return;
      }
      setCreated({ name: r.body.data.name, secret: r.body.data.secret });
      trackUsage("developers:webhook-created");
      setName("");
      setUrl("");
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    const r = await api(`/api/v1/webhooks/${id}`, { method: "DELETE" });
    setConfirmDelete(null);
    if (r.ok) {
      toast.success("Webhook removed.");
      reload();
    } else toast.error(errorMessage(r.body, "Could not remove that webhook."));
  }

  async function toggle(h: ApiWebhook) {
    const r = await api(`/api/v1/webhooks/${h.id}`, { method: "PATCH", body: JSON.stringify({ active: !h.active }) });
    if (r.ok) reload();
    else toast.error(errorMessage(r.body, "Could not update that webhook."));
  }

  async function sendTest(id: string) {
    const r = await api(`/api/v1/webhooks/${id}/test`, { method: "POST" });
    if (r.ok) {
      toast.success("Test event queued. It arrives within a few seconds; refresh deliveries to see the result.");
      setExpanded(id);
      setTimeout(reload, 4000);
    } else toast.error(errorMessage(r.body, "Could not send a test."));
  }

  function closeDialog(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreated(null);
      setError(null);
    }
  }

  function toggleEvent(e: WebhookEvent) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Webhooks</h3>
          <p className="text-xs text-muted-foreground">
            We call your URL within about a minute of something happening. Works with Zapier, Make, n8n or your own server.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-primary" />
              Everyone&apos;s
            </label>
          ) : null}
          <Button size="xs" variant="ghost" onClick={reload} aria-label="Refresh webhooks">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus data-icon="inline-start" /> Add webhook
          </Button>
        </div>
      </div>

      {hooks === null ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
      ) : hooks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <Webhook className="size-6 text-muted-foreground" />
          <p className="text-sm text-foreground">No webhooks yet.</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Get told the moment a post goes live, a status moves or a transcript is ready — instead of polling.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {hooks.map((h) => (
            <div key={h.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{h.name}</span>
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 text-[10px] font-semibold",
                        h.active ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {h.active ? "active" : "paused"}
                    </span>
                    {h.consecutive_failures > 0 ? (
                      <span className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] font-semibold text-destructive">
                        {h.consecutive_failures} failed in a row
                      </span>
                    ) : null}
                    {h.owner ? <span className="text-xs text-muted-foreground">· {h.owner.name ?? h.owner.email}</span> : null}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{h.url}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.events.map((e) => (
                      <code key={e} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                        {e}
                      </code>
                    ))}
                    {h.brand ? <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">brand={h.brand}</code> : null}
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>Last delivery {relative(h.last_delivery_at)}</div>
                  <div>Last success {relative(h.last_success_at)}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setExpanded(expanded === h.id ? null : h.id)}>
                    {expanded === h.id ? "Hide deliveries" : "Deliveries"}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => sendTest(h.id)}>
                    Send test
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => toggle(h)}>
                    {h.active ? "Pause" : "Resume"}
                  </Button>
                  {confirmDelete === h.id ? (
                    <>
                      <Button size="xs" variant="destructive" onClick={() => remove(h.id)}>
                        Confirm remove
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(h.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {expanded === h.id ? (
                <div className="mt-3 rounded-md border border-border">
                  {(deliveries[h.id] ?? []).length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">No deliveries yet. Press “Send test” to try it.</div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted-foreground">
                        <tr className="border-b border-border">
                          <th className="px-3 py-1.5 font-medium">When</th>
                          <th className="px-3 py-1.5 font-medium">Event</th>
                          <th className="px-3 py-1.5 font-medium">Status</th>
                          <th className="px-3 py-1.5 font-medium">Attempts</th>
                          <th className="px-3 py-1.5 font-medium">Last result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(deliveries[h.id] ?? []).map((d) => (
                          <tr key={d.id} className="border-b border-border last:border-0">
                            <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{relative(d.created_at)}</td>
                            <td className="px-3 py-1.5 font-mono">{d.event}</td>
                            <td
                              className={cn(
                                "px-3 py-1.5 font-semibold",
                                d.status === "delivered"
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : d.status === "failed"
                                    ? "text-destructive"
                                    : "text-muted-foreground",
                              )}
                            >
                              {d.status}
                            </td>
                            <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{d.attempts}</td>
                            <td className="px-3 py-1.5 font-mono text-muted-foreground">
                              {d.last_status_code ? `HTTP ${d.last_status_code}` : ""}
                              {d.last_error ? ` ${d.last_error}` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-lg">
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Webhook added: {created.name}</DialogTitle>
                <DialogDescription>
                  This is the signing secret. Copy it now — it is shown once. Use it to check that events really came from
                  Hub &amp; Spoke (optional for Zapier and Make).
                </DialogDescription>
              </DialogHeader>
              <CodeBlock code={created.secret} wrap />
              <p className="text-xs text-muted-foreground">
                Each delivery carries <code className="font-mono">X-HubSpoke-Signature: sha256=HMAC-SHA256(secret, timestamp + &quot;.&quot; + body)</code>{" "}
                and <code className="font-mono">X-HubSpoke-Timestamp</code>. Press “Send test” on the webhook to see one.
              </p>
              <DialogFooter>
                <Button onClick={() => closeDialog(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Add a webhook</DialogTitle>
                <DialogDescription>Paste the URL from Zapier, Make, n8n or your own server, then pick the events.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="wh-name">Name</Label>
                  <Input id="wh-name" autoFocus placeholder="e.g. Zapier → Slack #published" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="wh-url">URL</Label>
                  <Input id="wh-url" placeholder="https://hooks.zapier.com/hooks/catch/…" value={url} onChange={(e) => setUrl(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Events</Label>
                  {WEBHOOK_EVENTS.map((e) => (
                    <label key={e} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1 accent-primary" checked={events.has(e)} onChange={() => toggleEvent(e)} />
                      <span>
                        <code className="font-mono text-[12.5px] text-foreground">{e}</code>
                        <span className="block text-xs text-muted-foreground">{WEBHOOK_EVENT_DESCRIPTIONS[e]}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => closeDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={create} disabled={!name.trim() || !url.trim() || events.size === 0 || submitting}>
                  {submitting ? "Adding…" : "Add webhook"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
