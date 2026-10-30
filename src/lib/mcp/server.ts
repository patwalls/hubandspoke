/**
 * Hub & Spoke MCP server — the same read model as `/api/v1`, exposed as tools
 * so Claude, Cursor, ChatGPT and other assistants can answer "what did we
 * publish last week?" or "pull the transcript of that video" directly.
 *
 * Streamable HTTP, stateless: every POST to /api/v1/mcp builds a fresh server,
 * handles one JSON-RPC message and is done. No sessions to leak across dyno
 * restarts. Auth is the same Bearer API key as REST (src/lib/api/auth.ts).
 *
 * Tools are read-only (`readOnlyHint`). Keep tool results compact — a model
 * reads them — and keep names stable: people's saved prompts refer to them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ApiPrincipal } from "@/lib/api/auth";
import { listAccounts, listBrands, listFormats } from "@/lib/api/catalog";
import {
  CONTENT_SORTS,
  SOURCE_TYPES,
  getContent,
  getTranscript,
  listClipIdeas,
  listContent,
  listDerivatives,
  listMedia,
  renderTranscript,
} from "@/lib/api/content";
import { ApiError } from "@/lib/api/http";
import type { ApiContentItem } from "@/lib/api/serialize";
import { API_VERSION } from "@/lib/api/constants";
import { MCP_SERVER_NAME, MCP_TOOLS } from "./tools";
export { MCP_TOOLS, MCP_SERVER_NAME } from "./tools";


type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof ApiError ? `${err.type}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A model reads this — drop the hypermedia links, keep what it would ask for. */
function compact(item: ApiContentItem) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    brand: item.brand,
    post_type: item.post_type,
    source_type: item.source_type,
    format: item.format,
    account: item.account ? `${item.account.platform}/@${item.account.handle}` : null,
    url: item.url,
    hook: item.hook,
    published_at: item.published_at,
    views: item.metrics.views,
    likes: item.metrics.likes,
    comments: item.metrics.comments,
    hub_id: item.hub_id,
    has_transcript: item.has_transcript,
    editor: item.editor?.name ?? item.editor?.email ?? null,
    app_url: item.app_url,
  };
}

export interface McpContext {
  principal: ApiPrincipal;
  baseUrl: string;
  /** Called once per tool invocation so the request log can attribute it. */
  onToolCall?: (tool: string, ok: boolean, durationMs: number) => void;
}

const uuid = z.string().uuid().describe("Content item id (UUID)");

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: API_VERSION },
    {
      instructions: [
        "Hub & Spoke is the content command center for a group of media brands: long YouTube videos (hubs) and the clips, posts and newsletters made from them (spokes).",
        "Start with search_content to find items; it returns compact rows. Use get_content for full detail and get_transcript for what was said.",
        "Brand slugs come from list_brands; account ids from list_accounts. Dates are ISO-8601 (UTC). Views and likes are the latest synced numbers, not live.",
      ].join(" "),
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { title: name.replace(/_/g, " "), description, inputSchema: shape, annotations: readOnly },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        const started = performance.now();
        try {
          const result = ok(await run(args));
          ctx.onToolCall?.(name, true, performance.now() - started);
          return result;
        } catch (err) {
          ctx.onToolCall?.(name, false, performance.now() - started);
          return fail(err);
        }
      }) as never,
    );
  }

  tool("whoami", MCP_TOOLS[0].description, {}, async () => ({
    user: ctx.principal.user,
    auth: ctx.principal.auth,
    key: ctx.principal.key ? { name: ctx.principal.key.name, prefix: ctx.principal.key.keyPrefix } : null,
  }));

  tool(
    "list_brands",
    MCP_TOOLS[1].description,
    { include_disabled: z.boolean().optional().describe("Include brands switched off in Settings") },
    async (a) => (await listBrands(a)).data,
  );

  tool(
    "list_accounts",
    MCP_TOOLS[2].description,
    {
      brand: z.string().optional().describe("Brand slug; omit for all brands"),
      platform: z.string().optional().describe("youtube, instagram, x, tiktok, linkedin, threads, newsletter"),
      include_inactive: z.boolean().optional(),
    },
    async (a) => (await listAccounts(a)).data,
  );

  tool(
    "list_formats",
    MCP_TOOLS[3].description,
    { brand: z.string().optional().describe("Brand slug; omit for all brands") },
    async (a) => (await listFormats(a)).data,
  );

  tool(
    "search_content",
    MCP_TOOLS[4].description +
      " Returns compact rows, newest first, plus next_cursor when there are more. Pass cursor to get the next page.",
    {
      brand: z.string().optional().describe("Brand slug from list_brands; omit for all"),
      account_id: z.string().uuid().optional(),
      post_type: z
        .string()
        .optional()
        .describe("youtube_long, youtube_shorts, instagram_reel, instagram_post, x, tiktok, linkedin, threads, newsletter"),
      status: z.string().optional().describe("Workflow status, e.g. Published, Idea, Scheduled"),
      format: z.string().optional().describe("Format name from list_formats"),
      source_type: z.enum(SOURCE_TYPES).optional().describe("original = hub piece; repurposed = spoke clip; cross_post/repost"),
      hub_id: z.string().uuid().optional().describe("Only spokes made from this hub item"),
      q: z.string().optional().describe("Search titles, hooks and post bodies"),
      published_after: z.string().optional().describe("ISO date, inclusive"),
      published_before: z.string().optional().describe("ISO date, inclusive"),
      updated_after: z.string().optional().describe("ISO datetime — only items changed since"),
      has_transcript: z.boolean().optional(),
      sort: z.enum(CONTENT_SORTS).optional().describe("published_at (default), updated_at or views; always descending"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
      cursor: z.string().optional(),
    },
    async (a) => {
      const toDate = (s?: string) => {
        if (!s) return undefined;
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) throw new ApiError("invalid_request", `"${s}" is not an ISO date.`);
        return d;
      };
      const page = await listContent(
        {
          ...a,
          published_after: toDate(a.published_after),
          published_before: toDate(a.published_before),
          updated_after: toDate(a.updated_after),
        },
        ctx.baseUrl,
      );
      return { items: page.data.map(compact), has_more: page.has_more, next_cursor: page.next_cursor };
    },
  );

  tool("get_content", MCP_TOOLS[5].description, { id: uuid }, async (a) => getContent(a.id, ctx.baseUrl));

  tool(
    "get_transcript",
    MCP_TOOLS[6].description + " Use format=json for timed segments with speakers.",
    {
      id: uuid,
      format: z.enum(["text", "json", "vtt", "srt"]).optional().describe("Default text"),
    },
    async (a) => {
      const t = await getTranscript(a.id);
      const format = a.format ?? "text";
      if (format === "json") return t;
      return renderTranscript(t, format).body;
    },
  );

  tool("list_derivatives", MCP_TOOLS[7].description, { id: uuid }, async (a) =>
    (await listDerivatives(a.id, ctx.baseUrl)).data.map(compact),
  );

  tool(
    "list_clip_ideas",
    MCP_TOOLS[8].description,
    { id: uuid, status: z.enum(["suggested", "accepted", "killed"]).optional() },
    async (a) => (await listClipIdeas(a.id, { status: a.status })).data,
  );

  tool("get_media_links", MCP_TOOLS[9].description, { id: uuid }, async (a) => (await listMedia(a.id)).data);

  return server;
}

/** Handle one MCP HTTP request (stateless). */
export async function handleMcpRequest(request: Request, ctx: McpContext): Promise<Response> {
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Stateless: nothing to keep. Close asynchronously so the response isn't delayed.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
