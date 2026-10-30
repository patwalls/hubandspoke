import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { API_ENDPOINTS, routeDirFor } from "./registry";
import { MCP_TOOLS } from "@/lib/mcp/tools";

describe("endpoint registry", () => {
  it("every documented endpoint has a route file on disk", () => {
    for (const e of API_ENDPOINTS) {
      const file = resolve(process.cwd(), "src/app/api/v1", routeDirFor(e.path), "route.ts");
      expect(existsSync(file), `${e.method} ${e.path} → ${file}`).toBe(true);
    }
  });
  it("ids are unique and every MCP tool named by an endpoint exists", () => {
    const ids = API_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tools = new Set(MCP_TOOLS.map((t) => t.name));
    for (const e of API_ENDPOINTS) {
      if (e.mcpTool) expect(tools.has(e.mcpTool), `${e.id} → ${e.mcpTool}`).toBe(true);
    }
  });
  it("path params are declared and every param has a description", () => {
    for (const e of API_ENDPOINTS) {
      const inPath = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = e.params.filter((p) => p.in === "path").map((p) => p.name);
      expect(declared.sort()).toEqual(inPath.sort());
      for (const p of e.params) expect(p.description.length, `${e.id}.${p.name}`).toBeGreaterThan(10);
    }
  });
  it("maps paths to Next route directories", () => {
    expect(routeDirFor("/content/{id}/transcript")).toBe("content/[id]/transcript");
    expect(routeDirFor("/me")).toBe("me");
  });
});

describe("openapi document", () => {
  const doc = buildOpenApiDocument("https://hs.example.com");
  it("is 3.1 with a bearer scheme and one operation per endpoint", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://hs.example.com/api/v1");
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    const ops = Object.values(doc.paths).flatMap((p) => Object.keys(p));
    expect(ops).toHaveLength(API_ENDPOINTS.length);
  });
  it("operationIds are unique and every op has a 200 and a 401", () => {
    const ids = new Set<string>();
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path) as Array<{ operationId: string; responses: Record<string, unknown> }>) {
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
        expect(op.responses["200"]).toBeDefined();
        expect(op.responses["401"]).toBeDefined();
      }
    }
  });
});
