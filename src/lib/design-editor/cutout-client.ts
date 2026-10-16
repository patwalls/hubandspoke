/**
 * Background removal IN THE BROWSER with onnxruntime-web. The matting models
 * that do this well need far more memory at inference than a 512 MB worker
 * dyno has (BiRefNet: ~7 GB; ISNet: ~1 GB), while a laptop does it in a
 * second or two, so the editor makes the cutout itself and uploads the PNG
 * into the source's photo library (design_photos, kind "cutout"), where every
 * later post from the video — and the server-side hero fill — finds it.
 *
 * Models (served from our bucket by /api/design/cutout-model, cached by the
 * browser's Cache API after the first download):
 *   isnet  — ISNet general-use (DIS, Apache-2.0), 1024², ~180 MB: clean hair
 *            and hands even on busy backgrounds. What imgly's remover runs.
 *   modnet — MODNet portrait matting (Apache-2.0), 512², 26 MB: fast, weaker
 *            on busy backgrounds. The fallback.
 * Attempts run in order until one works: ISNet on WebGPU, ISNet on WASM,
 * MODNet on WebGPU, MODNet on WASM. BiRefNet (the best of them) is NOT in
 * the list: its WebGPU kernels fail to compile in current Chrome and it
 * needs ~7 GB on WASM. `localStorage.hsCutoutAttempt = "<index>"` pins one
 * attempt for debugging.
 *
 * onnxruntime-web is loaded from the jsDelivr CDN at runtime (one ESM file
 * plus its WASM) rather than bundled: the package's WebGPU build and its
 * worker/WASM assets don't survive Next's bundler cleanly.
 */
import { alphaBounds, type CutoutBounds } from "./cutout-geometry";
import type { ImageSource } from "@/lib/editor/image-source";

const ORT_VERSION = "1.23.2";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_CACHE = "hs-cutout-models-v1";

interface ModelSpec {
  name: "isnet" | "modnet";
  label: string;
  /** Square input size. */
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** The output is a logit (apply sigmoid) rather than a 0–1 mask. */
  sigmoid: boolean;
}

const MODELS: Record<ModelSpec["name"], ModelSpec> = {
  isnet: { name: "isnet", label: "ISNet", size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], sigmoid: false },
  modnet: { name: "modnet", label: "MODNet", size: 512, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], sigmoid: false },
};

interface Attempt {
  model: ModelSpec;
  ep: "webgpu" | "wasm";
}

const ATTEMPTS: Attempt[] = [
  { model: MODELS.isnet, ep: "webgpu" },
  { model: MODELS.isnet, ep: "wasm" },
  { model: MODELS.modnet, ep: "webgpu" },
  { model: MODELS.modnet, ep: "wasm" },
];

export const attemptLabel = (a: Attempt) => `${a.model.label} (${a.ep === "webgpu" ? "GPU" : "CPU"})`;

export type CutoutProgress = (message: string) => void;

/** The slice of onnxruntime-web this module uses. */
interface OrtModule {
  env: { wasm: { wasmPaths: string } };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(buffer: ArrayBuffer, opts: { executionProviders: string[] }): Promise<OrtSession> };
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>;
}

let ortPromise: Promise<OrtModule> | null = null;
const sessions = new Map<string, Promise<OrtSession>>();
const broken = new Set<number>();

export function cutoutSupported(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    const url = `${ORT_CDN}ort.webgpu.min.mjs`;
    ortPromise = (import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url) as Promise<OrtModule>).then((ort) => {
      ort.env.wasm.wasmPaths = ORT_CDN;
      return ort;
    });
    ortPromise.catch(() => {
      ortPromise = null;
    });
  }
  return ortPromise;
}

/** The model's bytes: the browser cache, else our bucket (via a presigned
 *  URL from the app) and into the cache for next time. */
async function modelBytes(spec: ModelSpec, progress?: CutoutProgress): Promise<ArrayBuffer> {
  const cacheKey = `/__hs-cutout-model/${spec.name}`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }
  const meta = await fetch(`/api/design/cutout-model?name=${spec.name}`);
  if (!meta.ok) throw new Error(`Couldn't get the ${spec.label} model (${meta.status})`);
  const { url } = (await meta.json()) as { url: string };
  progress?.(`Downloading the ${spec.label} model (one time)…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the ${spec.label} model (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let got = 0;
  let lastPct = -1;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      if (total) {
        const pct = Math.round((100 * got) / total);
        if (pct !== lastPct) {
          lastPct = pct;
          progress?.(`Downloading the ${spec.label} model (one time)… ${pct}%`);
        }
      }
    }
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  try {
    await cache?.put(cacheKey, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch {
    /* no room in the cache — next time downloads again */
  }
  return bytes.buffer;
}

async function session(i: number, progress?: CutoutProgress): Promise<OrtSession> {
  const key = String(i);
  const hit = sessions.get(key);
  if (hit) return hit;
  const attempt = ATTEMPTS[i];
  const p = (async () => {
    const ort = await loadOrt();
    const bytes = await modelBytes(attempt.model, progress);
    progress?.(`Preparing ${attemptLabel(attempt)}…`);
    return ort.InferenceSession.create(bytes, { executionProviders: [attempt.ep] });
  })();
  sessions.set(key, p);
  p.catch(() => sessions.delete(key));
  return p;
}

function pinnedAttempt(): number | null {
  try {
    const v = window.localStorage.getItem("hsCutoutAttempt");
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 && n < ATTEMPTS.length ? n : null;
  } catch {
    return null;
  }
}

function candidates(): number[] {
  const pinned = pinnedAttempt();
  if (pinned !== null) return [pinned];
  return ATTEMPTS.map((_, i) => i).filter((i) => !broken.has(i) && (ATTEMPTS[i].ep !== "webgpu" || hasWebGpu()));
}

/** Warm the best available model up in the background. */
export function preloadCutoutModel(progress?: CutoutProgress): void {
  if (!cutoutSupported()) return;
  const [first] = candidates();
  if (first !== undefined) void session(first, progress).catch(() => {});
}

/** The picture's bytes: the presigned URL (the bucket allows cross-origin
 *  GETs from the app's origin), else our own media proxy for S3 pictures
 *  (dev on localhost isn't in the bucket's CORS policy). */
async function readPicture(picture: { url: string; src: ImageSource }): Promise<Blob> {
  const urls = [picture.url];
  if (picture.src.kind === "s3") urls.push(`/api/media-proxy?key=${encodeURIComponent(picture.src.key)}`);
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (res.ok) return await res.blob();
      lastError = new Error(`Couldn't load the picture (${res.status})`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Couldn't load the picture");
}

/** Run one attempt: the alpha mask at the picture's size. */
async function matte(i: number, bitmap: ImageBitmap, progress?: CutoutProgress): Promise<Uint8ClampedArray> {
  const attempt = ATTEMPTS[i];
  const { size: S, mean, std, sigmoid } = attempt.model;
  const sess = await session(i, progress);
  const ort = await loadOrt();
  progress?.(`Finding the person — ${attemptLabel(attempt)}…`);
  // The picture squashed to the model's square (the mask is stretched back
  // the same way), channels-first, normalised.
  const square = new OffscreenCanvas(S, S);
  const sctx = square.getContext("2d");
  if (!sctx) throw new Error("No canvas");
  sctx.drawImage(bitmap, 0, 0, S, S);
  const px = sctx.getImageData(0, 0, S, S).data;
  const input = new Float32Array(3 * S * S);
  for (let i2 = 0; i2 < S * S; i2++) for (let c = 0; c < 3; c++) input[c * S * S + i2] = (px[i2 * 4 + c] / 255 - mean[c]) / std[c];
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) });
  const d = out[sess.outputNames[0]].data;
  const grey = sctx.createImageData(S, S);
  for (let i2 = 0; i2 < S * S; i2++) {
    const raw = Number(d[i2]);
    const v = sigmoid ? 1 / (1 + Math.exp(-raw)) : raw;
    const a = Math.max(0, Math.min(255, Math.round(v * 255)));
    grey.data[i2 * 4] = a;
    grey.data[i2 * 4 + 1] = a;
    grey.data[i2 * 4 + 2] = a;
    grey.data[i2 * 4 + 3] = 255;
  }
  sctx.putImageData(grey, 0, 0);
  const full = new OffscreenCanvas(bitmap.width, bitmap.height);
  const fctx = full.getContext("2d");
  if (!fctx) throw new Error("No canvas");
  fctx.drawImage(square, 0, 0, bitmap.width, bitmap.height);
  const stretched = fctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const alpha = new Uint8ClampedArray(bitmap.width * bitmap.height);
  for (let i2 = 0; i2 < alpha.length; i2++) alpha[i2] = stretched[i2 * 4];
  return alpha;
}

export interface CutoutResult {
  blob: Blob;
  width: number;
  height: number;
  /** Where the trimmed subject sat in the picture (0–1 fractions) — what
   *  "split into layers" lines the cutout up with. */
  bounds: CutoutBounds;
  /** The picture it was cut from, in px. */
  source: { width: number; height: number };
  /** Which model/device made it. */
  model: string;
}

/** Longest side of a saved cutout — 2× the 1080 canvas is plenty. */
const CUTOUT_MAX_SIDE = 2400;

/**
 * Cut the subject out of a picture: alpha from the matting model, the
 * picture trimmed to the opaque pixels (with a little padding) so the PNG
 * is person-shaped and `fit: contain` shows them at full size.
 */
export async function cutOutPicture(picture: { url: string; src: ImageSource }, progress?: CutoutProgress): Promise<CutoutResult> {
  if (!cutoutSupported()) throw new Error("Cutouts are made in the browser");
  progress?.("Reading the picture…");
  const blob = await readPicture(picture);
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  let alpha: Uint8ClampedArray | null = null;
  let used: Attempt | null = null;
  let lastError: unknown = null;
  for (const i of candidates()) {
    try {
      alpha = await matte(i, bitmap, progress);
      used = ATTEMPTS[i];
      break;
    } catch (err) {
      lastError = err;
      broken.add(i);
      sessions.delete(String(i));
      console.warn(`[cutout] ${attemptLabel(ATTEMPTS[i])} failed, trying the next:`, err instanceof Error ? err.message : err);
    }
  }
  if (!alpha || !used) {
    bitmap.close();
    throw lastError instanceof Error ? lastError : new Error("No cutout model could run in this browser");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let i = 0, n = width * height; i < n; i++) data[i * 4 + 3] = alpha[i];
  const bounds = alphaBounds(alpha, width, height, 16, Math.round(Math.max(width, height) * 0.015));
  if (!bounds) throw new Error("Couldn't find anyone in the picture");
  ctx.putImageData(pixels, 0, 0);
  // Capped so the PNG stays a few MB: a full-res camera photo makes a
  // 10 MB+ cutout, past what the upload accepts.
  const scale = Math.min(1, CUTOUT_MAX_SIDE / Math.max(bounds.w, bounds.h));
  const outW = Math.max(1, Math.round(bounds.w * scale));
  const outH = Math.max(1, Math.round(bounds.h * scale));
  const trimmed = document.createElement("canvas");
  trimmed.width = outW;
  trimmed.height = outH;
  const tctx = trimmed.getContext("2d")!;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, outW, outH);
  progress?.("Saving the cutout…");
  const png = await new Promise<Blob | null>((resolve) => trimmed.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Couldn't encode the cutout");
  return { blob: png, width: outW, height: outH, bounds: { x: bounds.x / width, y: bounds.y / height, w: bounds.w / width, h: bounds.h / height }, source: { width, height }, model: attemptLabel(used) };
}
