/**
 * Research script: does Descript's Underlord agent API honor layout-pack
 * references in the prompt body? The editor-side chat does — verified by
 * a teammate who applied a custom "ReelsLayout" pack via "Turn this video
 * into the layout pack called: Reels layout." The API endpoint is the same
 * Underlord backend, so it *should* work, but the only way to confirm is
 * to send a prompt and inspect the resulting composition.
 *
 * Two scenarios this script covers (same API call, different prompt):
 *
 *   Test A — on create: ask the agent to create a NEW composition AND apply
 *   the layout pack in the same call. Mirrors what `buildDescriptPrompt`
 *   in src/lib/services/promote-clip-idea.ts already does, plus a
 *   layout-pack line.
 *
 *   Test B — re-apply: ask the agent to apply the layout pack to an
 *   EXISTING composition by compositionId. Useful if Test A fails or for
 *   retro-applying packs to clips that were cut without one.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-descript-layout-pack.mjs \
 *     --project-id=<id> --prompt-inline="<prompt>" [--poll]
 *   node --env-file=.env.local scripts/test-descript-layout-pack.mjs \
 *     --project-id=<id> --prompt-file=path/to/prompt.txt --poll
 *
 * Modifies a real Descript project (creates / mutates compositions). Pick
 * a project that's safe to experiment in.
 */

const argv = process.argv.slice(2);
const args = {};
for (const raw of argv) {
  const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  args[m[1]] = m[2] ?? "true";
}

const projectId = args["project-id"];
const promptInline = args["prompt-inline"];
const promptFile = args["prompt-file"];
const shouldPoll = args.poll === "true";

if (!projectId) {
  console.error("Error: --project-id=<id> is required");
  process.exit(1);
}

let prompt = promptInline;
if (!prompt && promptFile) {
  const { readFileSync } = await import("node:fs");
  prompt = readFileSync(promptFile, "utf8");
}
if (!prompt) {
  console.error("Error: --prompt-inline=<text> or --prompt-file=<path> is required");
  process.exit(1);
}

const token = process.env.DESCRIPT_API_TOKEN;
if (!token) {
  console.error("Error: DESCRIPT_API_TOKEN not set (run with --env-file=.env.local)");
  process.exit(1);
}

const BASE = "https://descriptapi.com/v1";
const auth = `Bearer ${token}`;

console.error(`[invoke] project_id=${projectId}`);
console.error(`[invoke] prompt (${prompt.length} chars):`);
console.error("---");
console.error(prompt);
console.error("---");

const invokeRes = await fetch(`${BASE}/jobs/agent`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: auth,
  },
  body: JSON.stringify({ project_id: projectId, prompt }),
});
const invokeJson = await invokeRes.json();
if (!invokeRes.ok) {
  console.error(`[invoke] FAILED HTTP ${invokeRes.status}`);
  console.error(JSON.stringify(invokeJson, null, 2));
  process.exit(1);
}
console.error(`[invoke] job_id=${invokeJson.job_id}`);
console.error(`[invoke] project_url=${invokeJson.project_url}`);

if (!shouldPoll) {
  console.log(JSON.stringify(invokeJson, null, 2));
  process.exit(0);
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 10 * 60 * 1000;
const deadline = Date.now() + DEADLINE_MS;
let lastState = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  const r = await fetch(`${BASE}/jobs/${invokeJson.job_id}`, {
    headers: { Authorization: auth },
  });
  const j = await r.json();
  if (!r.ok) {
    console.error(`[poll] FAILED HTTP ${r.status}`);
    console.error(JSON.stringify(j, null, 2));
    process.exit(1);
  }
  if (j.job_state !== lastState) {
    console.error(`[poll] job_state=${j.job_state}`);
    lastState = j.job_state;
  }
  if (j.job_state === "stopped") {
    console.log(JSON.stringify(j, null, 2));
    const m = j.result?.agent_response?.match(/compositionId="([^"]+)"/);
    if (m) console.error(`[done] compositionId=${m[1]}`);
    console.error(`[done] project_url=${invokeJson.project_url}`);
    process.exit(0);
  }
}
console.error("[poll] deadline exceeded after 10 minutes");
process.exit(1);
