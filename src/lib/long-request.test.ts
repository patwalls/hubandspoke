import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { Agent } from "undici";
import OpenAI from "openai";
import { longRequestOptions } from "./long-request";

// A server that holds the response headers back for HOLD_MS, like OpenAI's
// diarize endpoint working on a 10-minute chunk.
// undici checks its timers on a ~0.5 s tick, so the gaps here are coarse.
const HOLD_MS = 2_000;
let server: Server;
let client: OpenAI;

beforeAll(async () => {
  server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
    }, HOLD_MS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  client = new OpenAI({ apiKey: "test", baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (opts: object) => client.post("/slow", { body: {}, ...opts });

describe("longRequestOptions", () => {
  it("the dispatcher's headersTimeout beats the SDK timeout (the bug: 12-min timeout, dead at 5)", async () => {
    // Stand-in for Node's default dispatcher (300 s) under a much longer SDK timeout.
    const shortDefault = new Agent({ headersTimeout: HOLD_MS / 4 });
    await expect(
      call({ timeout: HOLD_MS * 10, fetchOptions: { dispatcher: shortDefault } }),
    ).rejects.toThrow(/timed out/i);
  });

  it("raises the dispatcher's clocks to the SDK timeout, so a slow response lands", async () => {
    await expect(call(longRequestOptions(HOLD_MS * 10))).resolves.toEqual({ text: "ok" });
  });

  it("still enforces the timeout it was given", async () => {
    await expect(call(longRequestOptions(HOLD_MS / 4))).rejects.toThrow(/timed out/i);
  });
});
