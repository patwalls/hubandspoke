#!/usr/bin/env node
// One-shot OAuth helper for Canva Connect. Run once locally to mint a
// refresh_token, then stash the result in .env.local + Heroku config. Run again
// any time you need a fresh refresh_token (they don't expire, but you might
// want to rotate or you might have lost it). Throwaway tool — not wired into
// the app, not deployed. Lives in scripts/ next to the other ad-hoc helpers.
//
// Requires CANVA_CLIENT_ID + CANVA_CLIENT_SECRET in env. Reads from
// .env.local if you invoke via:
//   node --env-file=.env.local scripts/canva-oauth.mjs
//
// Prereqs in the Canva integration (Set Scopes page):
//   - design:content:read, design:content:write
//   - design:meta:read
//   - asset:read, asset:write
//   - brandtemplate:meta:read
//   Add the redirect URI http://127.0.0.1:8765/callback exactly as written.

import crypto from "node:crypto";
import http from "node:http";
import { URL, URLSearchParams } from "node:url";

const CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set. Try:",
  );
  console.error(
    "  node --env-file=.env.local scripts/canva-oauth.mjs",
  );
  process.exit(1);
}

const REDIRECT_URI = "http://127.0.0.1:8765/callback";
const SCOPES = [
  "design:content:read",
  "design:content:write",
  "design:meta:read",
  "asset:read",
  "asset:write",
  "brandtemplate:meta:read",
].join(" ");

// PKCE: code_verifier is a random 43-128 char string; code_challenge is the
// base64url-encoded SHA-256 of the verifier. Canva Connect requires PKCE for
// the authorization code flow.
function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const codeVerifier = base64url(crypto.randomBytes(64));
const codeChallenge = base64url(
  crypto.createHash("sha256").update(codeVerifier).digest(),
);
const state = base64url(crypto.randomBytes(16));

const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", codeChallenge);
authUrl.searchParams.set("code_challenge_method", "S256");

console.log("\n=== Canva OAuth ===\n");
console.log("1. Open this URL in your browser (logged into the Canva account");
console.log("   whose designs/templates this integration should access):\n");
console.log(`   ${authUrl.toString()}\n`);
console.log("2. Approve the integration. Canva will redirect to a local URL");
console.log("   that this script is listening on. Keep this terminal open.\n");

function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  return fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  }).then(async (res) => {
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `Token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
      throw new Error(`Token exchange failed: ${detail}`);
    }
    return json;
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description");

  if (err) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>OAuth error</h1><p>${err}: ${errDesc ?? ""}</p>`);
    console.error(`\nCanva returned an error: ${err}${errDesc ? ` (${errDesc})` : ""}`);
    setTimeout(() => process.exit(1), 100);
    return;
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing code");
    return;
  }
  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("state mismatch");
    console.error("\nState mismatch — possible CSRF. Aborting.");
    setTimeout(() => process.exit(1), 100);
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Done.</h1><p>You can close this tab. The terminal has your refresh token.</p>",
    );
    console.log("\n=== SUCCESS ===\n");
    console.log("Add these to .env.local:\n");
    console.log(`CANVA_CLIENT_ID=${CLIENT_ID}`);
    console.log(`CANVA_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`CANVA_REFRESH_TOKEN=${tokens.refresh_token}`);
    if (tokens.access_token) {
      console.log(`\n(Access token for immediate testing, expires soon: ${tokens.access_token.slice(0, 24)}…)`);
    }
    console.log("\nAnd for prod:");
    console.log(`  heroku config:set --app hubandspoke CANVA_CLIENT_ID='${CLIENT_ID}' CANVA_CLIENT_SECRET='${CLIENT_SECRET}' CANVA_REFRESH_TOKEN='${tokens.refresh_token}'`);
    setTimeout(() => process.exit(0), 100);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`token exchange failed: ${e.message}`);
    console.error(`\n${e.message}`);
    setTimeout(() => process.exit(1), 100);
  }
});

server.listen(8765, "127.0.0.1", () => {
  console.log("Listening on http://127.0.0.1:8765 for the Canva callback…\n");
});
