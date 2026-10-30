import { after, NextResponse } from "next/server";
import { authenticateApi, persistRequest } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { ApiError, apiError } from "@/lib/api/http";
import { handleMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/mcp — Hub & Spoke's MCP server (Streamable HTTP, stateless).
 * Connect from Claude Code, Cursor, Claude Desktop (via mcp-remote) or any MCP
 * client with `Authorization: Bearer hs_live_…`. Setup snippets: /developers.
 */
export async function POST(request: Request) {
  const started = performance.now();
  let principal;
  try {
    principal = await authenticateApi(request);
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError("internal_error", "Authentication failed.");
    return apiError(e);
  }
  const p = principal;
  let toolCalled = false;
  const response = await handleMcpRequest(request, {
    principal: p,
    baseUrl: baseUrlFrom(request),
    onToolCall: (tool, ok, durationMs) => {
      toolCalled = true;
      after(() =>
        persistRequest({
          apiKeyId: p.key?.id ?? null,
          userId: p.user.id,
          source: "mcp",
          method: "POST",
          route: "/v1/mcp",
          tool,
          status: ok ? 200 : 400,
          durationMs,
        }),
      );
    },
  });
  // Protocol traffic (initialize, tools/list) is logged once per POST without a tool name.
  if (!toolCalled) {
    after(() =>
      persistRequest({
        apiKeyId: p.key?.id ?? null,
        userId: p.user.id,
        source: "mcp",
        method: "POST",
        route: "/v1/mcp",
        tool: null,
        status: response.status,
        durationMs: performance.now() - started,
      }),
    );
  }
  return response;
}

/** The stateless server has no SSE stream to offer; tell GET callers how to connect. */
export async function GET() {
  return NextResponse.json(
    {
      name: "hubandspoke",
      transport: "streamable-http",
      message: "This is an MCP endpoint. Point an MCP client here with POST and an Authorization: Bearer hs_live_… header. Setup instructions: /developers.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
