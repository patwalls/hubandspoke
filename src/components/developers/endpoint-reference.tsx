"use client";

import { useState } from "react";
import { ChevronDown, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { API_ENDPOINTS, API_GROUPS, type ApiEndpoint } from "@/lib/api/registry";
import { trackUsage } from "@/lib/usage/track";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

function pathWith(e: ApiEndpoint, values: Record<string, string>): string {
  let path = e.path;
  const query = new URLSearchParams();
  for (const p of e.params) {
    const v = values[p.name]?.trim();
    if (!v) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(v));
    else query.set(p.name, v);
  }
  const qs = query.toString();
  return `/api/v1${path}${qs ? `?${qs}` : ""}`;
}

function EndpointCard({ e, baseUrl }: { e: ApiEndpoint; baseUrl: string }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ status: number; ms: number; body: string } | null>(null);

  const requestPath = pathWith(e, values);
  const missingPath = e.params.some((p) => p.in === "path" && !values[p.name]?.trim());

  async function run() {
    setRunning(true);
    const started = performance.now();
    try {
      // Session-authenticated: the API accepts the dashboard cookie, so trying
      // an endpoint never needs a key pasted into the page.
      const res = await fetch(requestPath, { headers: { Accept: "application/json" } });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // non-JSON (vtt/srt/text) — show as is
      }
      setResult({ status: res.status, ms: Math.round(performance.now() - started), body: pretty.slice(0, 20_000) });
      trackUsage("developers:try-it");
    } catch (err) {
      setResult({ status: 0, ms: 0, body: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div id={`endpoint-${e.id}`} className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
          {e.method}
        </span>
        <span className="font-mono text-[13px] text-foreground">/api/v1{e.path}</span>
        <span className="ml-auto hidden text-sm text-muted-foreground sm:inline">{e.summary}</span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-border px-4 py-4 lg:grid-cols-2">
          <div className="space-y-4">
            <p className="text-sm text-foreground">{e.description}</p>
            {e.params.length ? (
              <div>
                <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Parameters</h4>
                <div className="divide-y divide-border rounded-md border border-border">
                  {e.params.map((p) => (
                    <div key={p.name} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[180px_1fr]">
                      <div>
                        <code className="font-mono text-[12.5px] text-foreground">{p.name}</code>
                        <div className="text-[11px] text-muted-foreground">
                          {p.in === "path" ? "path · required" : p.required ? "required" : "optional"} · {p.type}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {p.description}
                        {p.enum ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {p.enum.map((v) => (
                              <code key={v} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                                {v}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No parameters.</p>
            )}
            <div>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Example response</h4>
              <CodeBlock code={JSON.stringify(e.example, null, 2)} className="max-h-80 overflow-auto" />
              {e.alsoReturns?.length ? (
                <p className="mt-1 text-[11px] text-muted-foreground">Also returns: {e.alsoReturns.join("; ")}.</p>
              ) : null}
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Try it</h4>
              <span className="text-[11px] text-muted-foreground">Runs as you, with your session — no key needed here.</span>
            </div>
            <div className="grid gap-2">
              {e.params.map((p) => (
                <label key={p.name} className="grid gap-1 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">
                    {p.name}
                    {p.in === "path" ? " *" : ""}
                  </span>
                  {p.enum ? (
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      value={values[p.name] ?? ""}
                      onChange={(ev) => setValues((v) => ({ ...v, [p.name]: ev.target.value }))}
                    >
                      <option value="">(any)</option>
                      {p.enum.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      className="h-8 text-sm"
                      placeholder={p.example ?? (p.type === "boolean" ? "true / false" : "")}
                      value={values[p.name] ?? ""}
                      onChange={(ev) => setValues((v) => ({ ...v, [p.name]: ev.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>
            <CodeBlock code={`curl "${baseUrl}${requestPath}" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`} wrap />
            <Button size="sm" onClick={run} disabled={running || missingPath}>
              <Play data-icon="inline-start" /> {running ? "Running…" : "Send request"}
            </Button>
            {missingPath ? <p className="text-[11px] text-muted-foreground">Fill the path parameter first.</p> : null}
            {result ? (
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono font-semibold",
                      result.status >= 200 && result.status < 300
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "bg-destructive/10 text-destructive",
                    )}
                  >
                    {result.status || "ERR"}
                  </span>
                  <span className="text-muted-foreground">{result.ms} ms</span>
                </div>
                <CodeBlock code={result.body} className="max-h-96 overflow-auto" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EndpointReference({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="space-y-6">
      {API_GROUPS.map((group) => {
        const list = API_ENDPOINTS.filter((e) => e.group === group);
        if (!list.length) return null;
        return (
          <div key={group} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{group}</h3>
            {list.map((e) => (
              <EndpointCard key={e.id} e={e} baseUrl={baseUrl} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
