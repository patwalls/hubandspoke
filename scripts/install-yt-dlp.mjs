// Downloads the self-contained yt-dlp binary for the current platform. Runs
// as a postinstall hook so the binary lands in the slug before the dyno boots
// — no Python dependency, no apt buildpack. Skippable via SKIP_YT_DLP_INSTALL=1
// (useful in CI where the worker code isn't exercised).

import { createWriteStream } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Tracks the "latest" GitHub release at install time. yt-dlp ships extractor
// fixes weekly in response to YouTube changes — following latest gets us those
// for free. If we ever need reproducible builds, swap this for a pinned tag.
const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = `${__dirname}/../node_modules/.yt-dlp-bin/yt-dlp`;

function assetForPlatform() {
  const { platform, arch } = process;
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux" && arch === "arm64") return "yt-dlp_linux_aarch64";
  if (platform === "linux") return "yt-dlp_linux";
  if (platform === "win32") return "yt-dlp.exe";
  throw new Error(`yt-dlp: unsupported platform ${platform}/${arch}`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`yt-dlp: fetch ${url} failed with ${res.status}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  if (process.env.SKIP_YT_DLP_INSTALL === "1") {
    console.log("yt-dlp install skipped (SKIP_YT_DLP_INSTALL=1).");
    return;
  }
  try {
    const existing = await stat(OUT_PATH);
    if (existing.size > 1_000_000) {
      console.log(`yt-dlp already present at ${OUT_PATH} (${existing.size} bytes), skipping download.`);
      return;
    }
  } catch {
    // not there yet; download
  }
  const asset = assetForPlatform();
  const url = `${RELEASE_BASE}/${asset}`;
  console.log(`yt-dlp: downloading ${asset} (latest) → ${OUT_PATH}`);
  await download(url, OUT_PATH);
  await chmod(OUT_PATH, 0o755);
  const finalStat = await stat(OUT_PATH);
  console.log(`yt-dlp: installed (${finalStat.size} bytes).`);
}

main().catch((err) => {
  console.error("yt-dlp install failed:", err.message);
  // Don't fail `npm install` — a broken yt-dlp only affects one task. The
  // worker will surface a clear error at runtime.
  process.exit(0);
});
