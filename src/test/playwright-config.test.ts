import { describe, it, expect, afterEach, vi } from "vitest";

// Every e2e run (the loop's browser check on the Mac included) must work
// without Playwright's optional ffmpeg download. On 2026-11-26 that cache
// entry went missing and `video: "retain-on-failure"` made every run die in
// auth.setup with "Executable doesn't exist at …/ffmpeg-mac".
async function loadConfig() {
  vi.resetModules();
  const mod = await import("../../playwright.config");
  return mod.default;
}

describe("playwright.config video", () => {
  const prev = process.env.E2E_VIDEO;
  afterEach(() => {
    if (prev === undefined) delete process.env.E2E_VIDEO;
    else process.env.E2E_VIDEO = prev;
  });

  it("records no video by default, so a run never needs ffmpeg", async () => {
    delete process.env.E2E_VIDEO;
    const config = await loadConfig();
    expect(config.use?.video).toBe("off");
  });

  it("records failing tests on video when E2E_VIDEO=1", async () => {
    process.env.E2E_VIDEO = "1";
    const config = await loadConfig();
    expect(config.use?.video).toBe("retain-on-failure");
  });

  it("no project turns video back on", async () => {
    delete process.env.E2E_VIDEO;
    const config = await loadConfig();
    for (const p of config.projects ?? []) {
      expect(p.use?.video ?? "off").toBe("off");
    }
  });
});
