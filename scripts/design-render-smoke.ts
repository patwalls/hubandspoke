/**
 * Dev smoke test for the design editor's render path — builds a Playbook doc
 * from a hardcoded brief and rasterizes every page with satori + resvg. No
 * DB, no S3, no AI.
 *
 *   npx tsx scripts/design-render-smoke.ts [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { buildPlaybookDoc } from "../src/lib/design-editor/playbook-template";
import { fontsUsed, pageToSatoriTree } from "../src/lib/design-editor/render-tree";

const out = path.resolve(process.argv[2] ?? "/tmp/design-smoke");
mkdirSync(out, { recursive: true });
const doc = buildPlaybookDoc(
  {
    stat: "$720K",
    statUnit: "/year",
    headline: "I stopped guessing what customers wanted. 2,000 calls later I had a $69K/month SaaS",
    highlights: [{ phrase: "stopped guessing", color: "red" }, { phrase: "$69K/month SaaS", color: "green" }],
    footer: "See his 3-Phase playbook→",
    notesTitle: "The 3-Phase Customer Call Playbook",
    phases: [
      { heading: "Phase 1: Customer Discovery — Reach Out & Frame", body: "Reach out to your personal network or DM people on Twitter (pay them if needed) to get on a call. Follow The Mom Test principles; never ask hypothetical questions like \"would you use this?\" Instead, ask how they currently solve the problem, how much time/money it costs, and what happens if they do nothing." },
      { heading: "Phase 2: Usability Testing — Fight 1-to-1 for Users", body: "Acquire early users via Reddit threads, lead magnets, and waitlist signups, then immediately invite them to a call. Share a link to your platform, ask them to share their screen, and speak as little as possible." },
      { heading: "Phase 3: Customer Success — Track & Identify Power Users", body: "Use analytics tools like PostHog to track usage and identify the users who engage with the platform the most. Get on calls with power users to understand specifically how the platform is delivering value." },
    ],
    caption: "…",
  },
  { kind: "url", url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" },
);
(async () => {
  for (const [i, page] of doc.pages.entries()) {
    const images: Record<string, string> = {};
    for (const el of page.elements) {
      if (el.type !== "image") continue;
      if (el.src.kind === "asset") {
        images[el.id] = `data:image/png;base64,${readFileSync(path.join("public", el.src.path)).toString("base64")}`;
      } else if (el.src.kind === "url") images[el.id] = el.src.url;
    }
    const t0 = Date.now();
    const svg = await satori(pageToSatoriTree(page, doc.canvas, images) as never, {
      width: doc.canvas.width,
      height: doc.canvas.height,
      fonts: fontsUsed(page).map((f) => ({
        name: f.cssFamily, weight: f.cssWeight as 400, style: "normal" as const,
        data: readFileSync(path.join("public/fonts/clip-editor", f.metrics.file)),
      })),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: doc.canvas.width } }).render().asPng();
    writeFileSync(path.join(out, `page-${i + 1}.png`), png);
    console.log(`page ${i + 1}: ${page.elements.length} elements, ${png.length} bytes, ${Date.now() - t0}ms`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
