#!/usr/bin/env node
// Throwaway smoke test for the Canva Connect API. Verifies the OAuth flow
// works end-to-end against the user's Canva account by:
//   1. exchanging the refresh token for an access token (Canva rotates the
//      refresh token on every exchange — we rewrite .env.local in-place
//      with the new RT so the next run still works)
//   2. listing brand templates (so we discover the right ID to autofill with)
//   3. creating an autofill job with empty data:{} against the brand template
//      whose name matches CANVA_TEMPLATE_NAME_HINT (defaults to "instagram tools")
//   4. polling the autofill job until it succeeds
//   5. printing the resulting design's edit URL
//
// Run with:
//   node --env-file=.env.local scripts/canva-smoke.mjs
//
// Optional: CANVA_TEMPLATE_NAME_HINT=foo to narrow the brand template match.
//           CANVA_BRAND_TEMPLATE_ID=EAHJfsp7GaE to skip listing and target directly.

import fs from "node:fs";
import path from "node:path";

const BASE_URL = "https://api.canva.com/rest";

const CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.CANVA_REFRESH_TOKEN;
const NAME_HINT = (
  process.env.CANVA_TEMPLATE_NAME_HINT ?? "instagram tools"
).toLowerCase();
const DIRECT_TEMPLATE_ID = process.env.CANVA_BRAND_TEMPLATE_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, and CANVA_REFRESH_TOKEN must be set.",
  );
  console.error("  node --env-file=.env.local scripts/canva-smoke.mjs");
  process.exit(1);
}

// Canva rotates the refresh token on every exchange — the old one is
// invalidated immediately. Rewrite .env.local in place with the new RT so the
// next invocation of this script still works. This is throwaway-script
// behavior; the production canva.ts client will persist to the DB instead.
function persistRotatedRefreshToken(newRefreshToken) {
  const envPath = path.join(process.cwd(), ".env.local");
  const before = fs.readFileSync(envPath, "utf8");
  const after = before.replace(
    /^CANVA_REFRESH_TOKEN=.*$/m,
    `CANVA_REFRESH_TOKEN=${newRefreshToken}`,
  );
  if (after === before) {
    console.warn(
      "      [warn] could not find CANVA_REFRESH_TOKEN line in .env.local to update",
    );
    return;
  }
  fs.writeFileSync(envPath, after);
  console.log("      rotated CANVA_REFRESH_TOKEN written to .env.local");
}

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: REFRESH_TOKEN,
  });
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `oauth/token returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `oauth/token failed: ${json?.error_description || json?.error || `HTTP ${res.status}`}`,
    );
  }
  if (json.refresh_token && json.refresh_token !== REFRESH_TOKEN) {
    persistRotatedRefreshToken(json.refresh_token);
  }
  return json.access_token;
}

async function authedFetch(url, opts, accessToken) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, raw: text };
}

async function listBrandTemplates(accessToken) {
  const r = await authedFetch(
    `${BASE_URL}/v1/brand-templates`,
    { method: "GET" },
    accessToken,
  );
  if (!r.ok) {
    throw new Error(
      `GET /v1/brand-templates failed: ${r.json?.message || r.json?.error || `HTTP ${r.status}`} — ${r.raw.slice(0, 300)}`,
    );
  }
  return r.json?.items ?? [];
}

async function fetchBrandTemplateDataset(accessToken, brandTemplateId) {
  const r = await authedFetch(
    `${BASE_URL}/v1/brand-templates/${brandTemplateId}/dataset`,
    { method: "GET" },
    accessToken,
  );
  if (!r.ok) {
    throw new Error(
      `GET /v1/brand-templates/${brandTemplateId}/dataset failed: ${r.json?.message || r.json?.error || `HTTP ${r.status}`} — ${r.raw.slice(0, 400)}`,
    );
  }
  return r.json?.dataset ?? r.json ?? {};
}

async function createAutofillJob(accessToken, brandTemplateId, dataset) {
  // Canva rejects autofill with `data: {}` when the template has any
  // autofill fields ("No matching fields in dataset"). Build a `data` object
  // keyed by every text field in the dataset, with a placeholder value, so
  // the smoke proves the autofill round-trip works. Production code will
  // fill these with real content extracted from the pillar.
  const data = {};
  for (const [name, spec] of Object.entries(dataset)) {
    const t = spec?.type;
    if (t === "text") {
      data[name] = {
        type: "text",
        text: `[smoke placeholder for ${name}]`,
      };
    } else if (t === "image") {
      // Skip image fields in the smoke; would need an uploaded asset id.
    } else if (t === "chart") {
      // Skip chart fields in the smoke.
    }
  }
  console.log(`      built autofill data for ${Object.keys(data).length} field(s): ${Object.keys(data).join(", ")}`);

  const r = await authedFetch(
    `${BASE_URL}/v1/autofills`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand_template_id: brandTemplateId,
        title: "[smoke] autofilled copy",
        data,
      }),
    },
    accessToken,
  );
  if (!r.ok) {
    throw new Error(
      `POST /v1/autofills failed: ${r.json?.message || r.json?.error || `HTTP ${r.status}`} — ${r.raw.slice(0, 500)}`,
    );
  }
  return r.json;
}

async function fetchAutofillJob(accessToken, jobId) {
  const r = await authedFetch(
    `${BASE_URL}/v1/autofills/${jobId}`,
    { method: "GET" },
    accessToken,
  );
  if (!r.ok) {
    throw new Error(
      `GET /v1/autofills/${jobId} failed: ${r.json?.message || r.json?.error || `HTTP ${r.status}`} — ${r.raw.slice(0, 300)}`,
    );
  }
  return r.json;
}

async function main() {
  console.log("[1/4] Exchanging refresh token for access token…");
  const accessToken = await getAccessToken();
  console.log(`      ok (access_token ${accessToken.slice(0, 24)}…)`);

  let match;
  if (DIRECT_TEMPLATE_ID) {
    console.log(`[2/4] Skipping listing — using CANVA_BRAND_TEMPLATE_ID=${DIRECT_TEMPLATE_ID}`);
    match = { id: DIRECT_TEMPLATE_ID, title: "(unknown — direct id)" };
  } else {
    console.log("[2/4] Listing brand templates…");
    const templates = await listBrandTemplates(accessToken);
    console.log(`      got ${templates.length} brand template(s)`);
    for (const t of templates) {
      console.log(`        - ${t.id}  "${t.title}"`);
    }
    if (templates.length === 0) {
      console.error(
        "\nNo brand templates found. The design needs to be saved as a brand template in Canva UI first (Share → Template → Save as brand template). If you already did this, double-check the OAuth flow was authorized against the same Canva account.",
      );
      process.exit(1);
    }

    match =
      templates.find((t) => (t.title ?? "").toLowerCase().includes(NAME_HINT)) ??
      templates[0];
    if (!match.title?.toLowerCase().includes(NAME_HINT)) {
      console.warn(
        `      no exact match for "${NAME_HINT}", falling back to first: "${match.title}"`,
      );
    } else {
      console.log(`      matched "${match.title}" (${match.id})`);
    }
  }

  // Hardcoded for the smoke: the other Claude tagged 3 fields when
  // publishing the brand template (hook, stack_list, cta — all text).
  // Skipping GET /v1/brand-templates/{id}/dataset because that requires the
  // brandtemplate:content:read scope, which we don't have on this integration
  // (and isn't needed for autofill itself).
  const knownFields = {
    hook: { type: "text" },
    stack_list: { type: "text" },
    cta: { type: "text" },
  };
  console.log("[3/4] Creating autofill job with placeholder text for hook/stack_list/cta…");
  const create = await createAutofillJob(accessToken, match.id, knownFields);
  console.log("      raw response:", JSON.stringify(create, null, 2));
  const jobId = create?.job?.id ?? create?.id;
  if (!jobId) {
    console.error("Could not find job id in response. Inspect the raw output above.");
    process.exit(1);
  }
  console.log(`      job_id=${jobId}`);

  console.log("[4/4] Polling autofill job…");
  const deadline = Date.now() + 60_000;
  let result = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const job = await fetchAutofillJob(accessToken, jobId);
    const status = job?.job?.status ?? job?.status;
    console.log(`      attempt ${attempt}: status=${status}`);
    if (status === "success") {
      result = job;
      break;
    }
    if (status === "failed") {
      console.error("\nJob failed. Raw:");
      console.error(JSON.stringify(job, null, 2));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!result) {
    console.error("\nTimed out after 60s. The job is still running.");
    process.exit(1);
  }

  const designId =
    result?.job?.result?.design?.id ??
    result?.result?.design?.id ??
    result?.design?.id;
  const designUrl =
    result?.job?.result?.design?.url ??
    result?.result?.design?.url ??
    result?.design?.url;
  console.log("\n=== SUCCESS ===");
  console.log(`brand_template_id : ${match.id}`);
  console.log(`design_id         : ${designId}`);
  console.log(`design_url        : ${designUrl}`);
  console.log("\nFull job result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
