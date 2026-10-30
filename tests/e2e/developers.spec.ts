import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";

/** The What's new pop-up shows once per user after a card ships; it would sit over the page. */
async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

/**
 * /developers: the API hub. Creates a real key through the UI, proves the key
 * works against /api/v1 (REST and MCP) with no cookie, then revokes it and
 * proves it stops working. Cleans up after itself (the key is revoked, and a
 * revoked key is a row the UI shows greyed — fine for the shared dev DB).
 */
test("create a key, use it on REST + MCP, revoke it", async ({ page, baseURL }) => {
  await page.goto("/developers");
  await dismissWhatsNew(page);
  await expect(page.getByRole("heading", { name: "API & MCP" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "API keys", level: 2 })).toBeVisible();

  const name = `e2e ${Date.now()}`;
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`Your new key: ${name}`)).toBeVisible();
  const key = (await dialog.locator("pre code").innerText()).trim();
  expect(key).toMatch(/^hs_live_[A-Za-z0-9]{32}$/);
  await dialog.getByRole("button", { name: "Done" }).click();

  // The quickstart now carries the real key.
  await expect(page.locator("#quickstart")).toContainText(key);
  await expect(page.getByRole("cell", { name }).first()).toBeVisible();

  // REST, no cookie: the test runner applies the project's storageState to new
  // contexts too, so pass an empty one — these calls must carry only the Bearer header.
  const api = await playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const me = await api.get("/api/v1/me", { headers: { Authorization: `Bearer ${key}` } });
  expect(me.status()).toBe(200);
  const meBody = (await me.json()) as { data: { auth: string; key: { name: string }; user: { email: string } } };
  expect(meBody.data.auth).toBe("api_key");
  expect(meBody.data.key.name).toBe(name);
  expect(meBody.data.user.email.toLowerCase()).toBe(process.env.E2E_TEST_USER_EMAIL!.toLowerCase());
  expect(me.headers()["x-ratelimit-limit"]).toBeTruthy();

  const list = await api.get("/api/v1/content?limit=2", { headers: { Authorization: `Bearer ${key}` } });
  expect(list.status()).toBe(200);
  const listBody = (await list.json()) as { data: unknown[]; has_more: boolean };
  expect(Array.isArray(listBody.data)).toBe(true);

  const noKey = await api.get("/api/v1/content");
  expect(noKey.status()).toBe(401);
  expect(((await noKey.json()) as { error: { type: string } }).error.type).toBe("unauthorized");

  // MCP handshake + tool list with the same key.
  const init = await api.post("/api/v1/mcp", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/event-stream" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    },
  });
  expect(init.status()).toBe(200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  expect(initBody.result.serverInfo.name).toBe("hubandspoke");

  const tools = await api.post("/api/v1/mcp", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  expect(tools.status()).toBe(200);
  const toolNames = ((await tools.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  expect(toolNames).toEqual(expect.arrayContaining(["search_content", "get_transcript", "whoami"]));

  const whoami = await api.post("/api/v1/mcp", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
  });
  const whoamiBody = (await whoami.json()) as { result: { content: Array<{ text: string }> } };
  expect(whoamiBody.result.content[0].text).toContain(name);

  // Activity shows what we just did (logged after the response; give it a beat).
  await page.locator("#activity").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("#activity")).toContainText("/v1/me", { timeout: 10_000 });
  await expect(page.locator("#activity")).toContainText("whoami");

  // Revoke → the key is dead immediately.
  const row = page.locator("#keys").getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(row).toContainText("Revoked");
  const after = await api.get("/api/v1/me", { headers: { Authorization: `Bearer ${key}` } });
  expect(after.status()).toBe(401);
  expect(((await after.json()) as { error: { message: string } }).error.message).toContain("revoked");

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  await api.dispose();
});

test("the reference's Try it runs an endpoint with the session", async ({ page }) => {
  await page.goto("/developers#reference");
  await dismissWhatsNew(page);
  const brands = page.locator("#endpoint-brands\\.list");
  await brands.getByRole("button", { expanded: false }).click();
  await brands.getByRole("button", { name: "Send request" }).click();
  await expect(brands.getByText("200")).toBeVisible({ timeout: 15_000 });
  await expect(brands.locator("pre").last()).toContainText('"slug"');
});
