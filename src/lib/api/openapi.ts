/**
 * Build the OpenAPI 3.1 document from the endpoint registry. Served at
 * `GET /api/v1/openapi.json` (public, no secrets) so Postman, Zapier, custom
 * GPTs and code generators can import it.
 */
import { API_ENDPOINTS, type ApiEndpoint, type ApiParam } from "./registry";
import { RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { API_VERSION } from "./constants";

export { API_VERSION };

function schemaFor(p: ApiParam) {
  const schema: Record<string, unknown> = { type: p.type };
  if (p.enum) schema.enum = [...p.enum];
  if (p.type === "integer") {
    schema.minimum = 1;
    if (p.name === "limit") schema.maximum = 100;
  }
  if (p.name === "id" || p.name.endsWith("_id")) schema.format = "uuid";
  return schema;
}

function operation(e: ApiEndpoint) {
  const content: Record<string, unknown> = {
    "application/json": { schema: { type: "object" }, example: e.example },
  };
  for (const extra of e.alsoReturns ?? []) {
    const mime = extra.split(" ")[0];
    content[mime] = { schema: { type: "string" } };
  }
  return {
    operationId: e.id.replace(/\./g, "_"),
    summary: e.summary,
    description: e.description,
    tags: [e.group],
    parameters: e.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.in === "path" ? true : Boolean(p.required),
      description: p.description,
      schema: schemaFor(p),
      ...(p.example ? { example: p.example } : {}),
    })),
    responses: {
      "200": { description: "OK", content },
      "400": { $ref: "#/components/responses/InvalidRequest" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "404": { $ref: "#/components/responses/NotFound" },
      "429": { $ref: "#/components/responses/RateLimited" },
    },
  };
}

export function buildOpenApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_ENDPOINTS) {
    paths[e.path] ??= {};
    paths[e.path][e.method.toLowerCase()] = operation(e);
  }
  const errorResponse = (description: string, type: string, message: string) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: { type, message } },
      },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Hub & Spoke API",
      version: API_VERSION,
      description: [
        "Read access to everything in Hub & Spoke: content across platforms, transcripts, media, clip ideas, brands, accounts and formats.",
        "",
        `Authenticate with an API key from ${baseUrl}/developers, sent as \`Authorization: Bearer hs_live_…\`.`,
        `Rate limit: ${RATE_LIMIT_PER_MINUTE} requests per minute per key (see the X-RateLimit-* headers).`,
        "Lists are wrapped in `{ data: [...] }`; paginated lists add `has_more` and `next_cursor`.",
        "Errors are `{ error: { type, message } }` with a matching HTTP status.",
        "",
        `An MCP server for AI assistants lives at ${baseUrl}/api/v1/mcp (same key).`,
      ].join("\n"),
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Getting started" },
      { name: "Content" },
      { name: "Transcripts & media" },
      { name: "Workspace" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API key created on the Developers page (hs_live_…). `X-API-Key: <key>` is accepted too.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["type", "message"],
              properties: {
                type: {
                  type: "string",
                  enum: ["unauthorized", "forbidden", "not_found", "invalid_request", "rate_limited", "internal_error"],
                },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
      },
      responses: {
        InvalidRequest: errorResponse("A parameter is missing or malformed.", "invalid_request", "One or more query parameters are invalid."),
        Unauthorized: errorResponse("Missing, invalid, revoked or expired API key.", "unauthorized", "Invalid API key."),
        NotFound: errorResponse("No such record, or it was deleted.", "not_found", "No content item with that id."),
        RateLimited: errorResponse("Too many requests this minute.", "rate_limited", `Rate limit is ${RATE_LIMIT_PER_MINUTE} requests per minute per key.`),
      },
    },
  };
}
