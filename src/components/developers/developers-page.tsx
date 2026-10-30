"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, BookOpen, Code2, KeyRound, Activity, Sparkles } from "lucide-react";
import { RATE_LIMIT_PER_MINUTE } from "@/lib/api/rate-limit";
import { API_ENDPOINTS } from "@/lib/api/registry";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { cn } from "@/lib/utils";
import { ActivityTable } from "./activity-table";
import { ApiKeysPanel } from "./api-keys-panel";
import { CodeBlock } from "./code-block";
import { EndpointReference } from "./endpoint-reference";
import { McpSetup } from "./mcp-setup";
import { curlSnippet, javascriptSnippet, openApiUrl, pythonSnippet, sheetsSnippet } from "./snippets";

const SECTIONS = [
  { id: "keys", label: "API keys", icon: KeyRound },
  { id: "quickstart", label: "Quickstart", icon: Sparkles },
  { id: "reference", label: "Reference", icon: BookOpen },
  { id: "mcp", label: "AI assistants (MCP)", icon: Bot },
  { id: "activity", label: "Activity", icon: Activity },
] as const;

const LANGS = [
  { id: "curl", label: "curl", build: curlSnippet },
  { id: "js", label: "JavaScript", build: javascriptSnippet },
  { id: "python", label: "Python", build: pythonSnippet },
  { id: "sheets", label: "Google Sheets", build: sheetsSnippet },
] as const;

export function DevelopersPage({
  baseUrl,
  isAdmin,
  userEmail,
}: {
  baseUrl: string;
  isAdmin: boolean;
  userEmail: string;
}) {
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [lang, setLang] = useState<(typeof LANGS)[number]["id"]>("curl");
  const snippet = LANGS.find((l) => l.id === lang)!.build(baseUrl, freshKey ?? undefined);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr] md:gap-8">
      <aside className="self-start md:sticky md:top-4">
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-foreground sm:text-2xl">API &amp; MCP</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Hub &amp; Spoke in your own tools</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <s.icon className="size-3.5" />
              {s.label}
            </a>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 space-y-10">
        <section className="space-y-4">
          <div className="rounded-lg border border-border bg-gradient-to-br from-card to-muted/40 p-5">
            <h2 className="text-base font-semibold text-foreground">Everything in Hub &amp; Spoke, available to your tools</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Every video, Short, reel, post, tweet and newsletter across all brands, their transcripts, media files,
              clip ideas and performance numbers. Pull it into a spreadsheet, a report, Zapier or Make, a script, or
              let an AI assistant work with it directly. Read-only, so nothing you build here can change anything in the app.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Stat label="Endpoints" value={String(API_ENDPOINTS.length)} hint="REST, JSON, cursor pagination" />
              <Stat label="MCP tools" value={String(MCP_TOOLS.length)} hint="Claude, Cursor and more" />
              <Stat label="Rate limit" value={`${RATE_LIMIT_PER_MINUTE}/min`} hint="per key" />
            </div>
            <div className="mt-4 flex flex-wrap gap-3 text-xs">
              <span className="text-muted-foreground">
                Base URL <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{baseUrl}/api/v1</code>
              </span>
              <Link href={openApiUrl(baseUrl)} target="_blank" className="text-primary underline-offset-2 hover:underline">
                OpenAPI spec (for Postman, Zapier, custom GPTs)
              </Link>
            </div>
          </div>
        </section>

        <Section id="keys" title="API keys" icon={KeyRound}>
          <ApiKeysPanel isAdmin={isAdmin} onKeyCreated={setFreshKey} />
        </Section>

        <Section
          id="quickstart"
          title="Quickstart"
          icon={Sparkles}
          intro={
            freshKey
              ? "Your new key is filled in below. Paste one of these and run it."
              : "Create a key above, then paste one of these — replace YOUR_API_KEY with it."
          }
        >
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap gap-1">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs",
                    lang === l.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <CodeBlock code={snippet} />
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <Tip title="Lists come in pages">
                Each list returns up to 100 items with <code className="font-mono">has_more</code> and{" "}
                <code className="font-mono">next_cursor</code>. Pass the cursor back to get the next page.
              </Tip>
              <Tip title="Sync only what changed">
                <code className="font-mono">updated_after=2026-10-01T00:00:00Z</code> on /content returns just the items
                edited or re-synced since then.
              </Tip>
              <Tip title="No-code tools">
                Zapier, Make and n8n: use their &ldquo;HTTP request&rdquo; step with the Bearer header. Postman: import the
                OpenAPI link above.
              </Tip>
            </div>
          </div>
        </Section>

        <Section
          id="reference"
          title="Reference"
          icon={BookOpen}
          intro="Click an endpoint to see its parameters, an example response, and run it against your real data."
        >
          <EndpointReference baseUrl={baseUrl} />
          <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide">Errors</h4>
            Every error is <code className="font-mono">{`{ "error": { "type", "message" } }`}</code> with a matching
            status: <code className="font-mono">invalid_request</code> 400, <code className="font-mono">unauthorized</code> 401,{" "}
            <code className="font-mono">not_found</code> 404, <code className="font-mono">rate_limited</code> 429. Check{" "}
            <code className="font-mono">X-RateLimit-Remaining</code> on every response.
          </div>
        </Section>

        <Section id="mcp" title="AI assistants (MCP)" icon={Bot}>
          <McpSetup baseUrl={baseUrl} apiKey={freshKey} />
        </Section>

        <Section id="activity" title="Activity" icon={Activity}>
          <ActivityTable isAdmin={isAdmin} />
        </Section>

        <p className="pb-6 text-xs text-muted-foreground">
          Signed in as {userEmail}. Keys you create inherit your access: {isAdmin ? "admin — every brand." : "you can read every brand."}{" "}
          <Code2 className="inline size-3" /> Something missing from the API? Tell Pat what you&apos;re building.
        </p>
      </main>
    </div>
  );
}

function Section({
  id,
  title,
  icon: Icon,
  intro,
  children,
}: {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </h2>
        {intro ? <p className="mt-0.5 text-sm text-muted-foreground">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function Tip({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-2.5">
      <div className="mb-0.5 font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}
