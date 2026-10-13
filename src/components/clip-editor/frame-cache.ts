/**
 * Thumbnails for the timeline's filmstrip, grabbed in the browser from a
 * hidden <video> of the source.
 *
 * The source lives in S3 behind a presigned URL, and that bucket's CORS only
 * allows PUT — so the frames we draw are "tainted": we can paint them onto
 * the page but never read their pixels back. That's all a filmstrip needs.
 * Frames go into small canvases (drawing a tainted canvas onto another one is
 * allowed), keyed by source time.
 *
 * One seek at a time, newest request first, so whatever just scrolled into
 * view fills in before what scrolled past.
 */

const FRAME_W = 160;
const MAX_FRAMES = 400;
const MAX_PENDING = 120;
const SEEK_TIMEOUT_MS = 4000;

export class FrameCache {
  private video: HTMLVideoElement;
  private frames = new Map<string, HTMLCanvasElement>();
  private pending = new Map<string, number>();
  private busy = false;
  private ready = false;
  private dead = false;
  private listeners = new Set<() => void>();
  private version = 0;
  private emitQueued = false;
  /** width / height of the source; 16:9 until the metadata says otherwise. */
  aspect = 16 / 9;

  constructor(url: string) {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    v.addEventListener("loadedmetadata", () => {
      if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
      this.ready = true;
      this.emit();
      void this.pump();
    });
    this.video = v;
  }

  static key(sec: number): string {
    return sec.toFixed(2);
  }

  get(sec: number): HTMLCanvasElement | undefined {
    return this.frames.get(FrameCache.key(sec));
  }

  /** Ask for the frame at `sec`; subscribers hear when it lands. */
  request(sec: number): void {
    const key = FrameCache.key(sec);
    if (this.frames.has(key) || this.dead) return;
    this.pending.delete(key); // re-insert = newest
    this.pending.set(key, sec);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    void this.pump();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  destroy(): void {
    this.dead = true;
    this.pending.clear();
    this.listeners.clear();
    this.video.removeAttribute("src");
    this.video.load();
  }

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    requestAnimationFrame(() => {
      this.emitQueued = false;
      this.version++;
      for (const fn of this.listeners) fn();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.ready || this.dead) return;
    this.busy = true;
    try {
      while (this.pending.size > 0 && !this.dead) {
        const [key, sec] = [...this.pending.entries()].pop()!;
        this.pending.delete(key);
        if (this.frames.has(key)) continue;
        await this.seek(sec);
        if (this.dead) return;
        const c = document.createElement("canvas");
        c.width = FRAME_W;
        c.height = Math.round(FRAME_W / this.aspect);
        c.getContext("2d")?.drawImage(this.video, 0, 0, c.width, c.height);
        this.frames.set(key, c);
        while (this.frames.size > MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!);
        this.emit();
      }
    } finally {
      this.busy = false;
    }
  }

  private seek(sec: number): Promise<void> {
    const v = this.video;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        v.removeEventListener("seeked", done);
        resolve();
      };
      const timer = setTimeout(done, SEEK_TIMEOUT_MS);
      v.addEventListener("seeked", done);
      v.currentTime = Math.max(0, Math.min(sec, (v.duration || sec) - 0.05));
    });
  }
}
