"use client";

import { useState } from "react";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { claudeCodeSnippet, claudeDesktopSnippet, cursorSnippet, mcpUrl } from "./snippets";

const CLIENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "claude-desktop", label: "Claude Desktop" },
] as const;
type ClientId = (typeof CLIENTS)[number]["id"];

export function McpSetup({ baseUrl, apiKey }: { baseUrl: string; apiKey: string | null }) {
  const [client, setClient] = useState<ClientId>("claude-desktop");
  const key = apiKey ?? undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-foreground">
          MCP lets an AI assistant use Hub &amp; Spoke directly. Connect once and you can ask things like{" "}
          <em>&ldquo;what did Starter Story publish on YouTube this month and how did it do?&rdquo;</em> or{" "}
          <em>&ldquo;pull the transcript of our latest interview and draft five tweets&rdquo;</em>. It is read-only.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Create an API key above (name it after the assistant).</li>
          <li>Pick your app and paste the config. Replace <code className="font-mono">YOUR_API_KEY</code> if it isn&apos;t filled in.</li>
          <li>Restart the app. You should see a &ldquo;hubandspoke&rdquo; server with {MCP_TOOLS.length} tools.</li>
        </ol>
        <div className="flex flex-wrap gap-1 pt-1">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setClient(c.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                client === c.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {client === "claude-code" ? (
          <>
            <CodeBlock label="Terminal" code={claudeCodeSnippet(baseUrl, key)} wrap />
            <p className="text-xs text-muted-foreground">Then ask Claude Code anything about your content.</p>
          </>
        ) : client === "cursor" ? (
          <>
            <CodeBlock label=".cursor/mcp.json (or Cursor Settings → MCP → Add)" code={cursorSnippet(baseUrl, key)} />
          </>
        ) : (
          <>
            <CodeBlock
              label="claude_desktop_config.json (Settings → Developer → Edit Config)"
              code={claudeDesktopSnippet(baseUrl, key)}
            />
            <p className="text-xs text-muted-foreground">
              Claude Desktop&apos;s config file only runs local commands, so this uses the small{" "}
              <code className="font-mono">mcp-remote</code> bridge (needs Node.js installed). Claude.ai&apos;s web
              &ldquo;Connectors&rdquo; need OAuth sign-in, which this server does not offer yet — use the desktop app.
            </p>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Any other MCP client: Streamable HTTP at <code className="font-mono">{mcpUrl(baseUrl)}</code> with header{" "}
          <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tools the assistant gets</h4>
        <ul className="space-y-2">
          {MCP_TOOLS.map((t) => (
            <li key={t.name} className="text-sm">
              <code className="font-mono text-[12.5px] text-foreground">{t.name}</code>
              <div className="text-xs text-muted-foreground">{t.description}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
