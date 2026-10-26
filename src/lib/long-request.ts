// Request options for an SDK call that may legitimately wait minutes for a
// response (OpenAI diarize, non-streaming Anthropic calls with thinking).
//
// The SDKs' `timeout` is NOT the only clock. They call Node's built-in fetch,
// whose default undici dispatcher gives up after 300 s with no response
// headers (`headersTimeout`) or 300 s between body bytes (`bodyTimeout`) — and
// the SDK reports that as "Request timed out.", same as its own timeout. So a
// `timeout: 12 * 60_000` silently meant 5 minutes. Prod, 2026-10-26: every
// diarize chunk failed at 300.7 s once OpenAI's calls crossed 5 minutes.
//
// Pass the result as the SDK's per-request options; spread in `signal` etc.
import { Agent } from "undici";

const agents = new Map<number, Agent>();

function agentFor(timeoutMs: number): Agent {
  let agent = agents.get(timeoutMs);
  if (!agent) {
    agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    agents.set(timeoutMs, agent);
  }
  return agent;
}

export function longRequestOptions(timeoutMs: number) {
  return {
    timeout: timeoutMs,
    // undici's Agent and the SDKs' RequestInit come from different copies of
    // undici's types; the runtime contract (`dispatch`) is the same.
    fetchOptions: { dispatcher: agentFor(timeoutMs) } as Record<string, unknown>,
  };
}
