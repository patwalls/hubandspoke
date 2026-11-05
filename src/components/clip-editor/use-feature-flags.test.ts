import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { loadFeatureFlags, useFeatureFlags } from "./use-feature-flags";

function Probe() {
  const flags = useFeatureFlags();
  return createElement("span", null, flags?.clipEditor ? "flag-on" : "flag-off");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFeatureFlags", () => {
  // Regression: GlitchTip HUBANDSPOKE-4 (React #418 on /:brand/queue). The
  // server renders with no flags; a boundary that hydrated after the flags
  // fetch resolved started from the warm module cache and rendered flag-on
  // markup over flag-off HTML. The first (server / hydration) render must
  // ignore the cache no matter how warm it is.
  it("renders flags-off on the server/hydration pass even with a warm cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ flags: { clipEditor: true } }))),
    );
    const flags = await loadFeatureFlags();
    expect(flags?.clipEditor).toBe(true);

    expect(renderToString(createElement(Probe))).toBe("<span>flag-off</span>");
  });
});
