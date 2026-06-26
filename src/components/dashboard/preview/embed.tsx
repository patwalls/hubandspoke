"use client";

import { useEffect, useRef } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { PlatformKey } from "@/lib/platform-field-schemas";
import { buttonVariants } from "@/components/ui/button";
import { resolveEmbed } from "./embed-helpers";

const loadedScripts = new Set<string>();

function loadScript(src: string) {
  if (typeof document === "undefined") return;
  if (loadedScripts.has(src)) {
    // Scripts that are already loaded sometimes need a nudge to re-scan DOM
    // when their embed target re-mounts (twttr, tiktok). Both re-scan on load.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) return;
  }
  const s = document.createElement("script");
  s.src = src;
  s.async = true;
  s.charset = "utf-8";
  document.body.appendChild(s);
  loadedScripts.add(src);
}

export function PreviewEmbed({
  platform,
  publishedLink,
  newsletterBodyHtml,
}: {
  platform: PlatformKey;
  publishedLink: string | null;
  /** Raw HTML captured by the Klaviyo enricher. When present on a
   *  newsletter, we render it in a sandboxed iframe instead of the
   *  link-only fallback so the post can be read in place. */
  newsletterBodyHtml?: string | null;
}) {
  const resolution = resolveEmbed(platform, publishedLink);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Newsletters: render the captured HTML body when we have it. The iframe
  // is fully sandboxed (no JS, no same-origin, no form submission) so the
  // email's inline styles can't bleed into the parent and any embedded
  // <script> tags are inert. `allow-popups` lets the reader open links —
  // they break out of the sandbox so target="_top" still works.
  if (platform === "newsletter" && newsletterBodyHtml) {
    return (
      <iframe
        title="Newsletter body"
        srcDoc={newsletterBodyHtml}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="w-full rounded-md border border-border bg-white"
        style={{ height: 720 }}
        loading="lazy"
      />
    );
  }

  useEffect(() => {
    if (resolution.kind !== "script") return;

    // TikTok's embed.js scans the DOM for unprocessed `.tiktok-embed`
    // blockquotes only when it (re)loads. In an SPA the blockquote mounts
    // AFTER the script first ran, and it exposes no public re-scan API — so
    // the placeholder (blank box + logo) never becomes the video. Force a
    // re-scan by re-injecting the script each time the embed mounts/changes.
    if (resolution.script.includes("tiktok.com/embed")) {
      const prev = document.querySelector(
        'script[src^="https://www.tiktok.com/embed"]',
      );
      if (prev) prev.remove();
      const s = document.createElement("script");
      s.src = "https://www.tiktok.com/embed.js";
      s.async = true;
      s.charset = "utf-8";
      document.body.appendChild(s);
      return;
    }

    loadScript(resolution.script);

    // Nudge platform scripts that have already loaded to re-scan for the
    // blockquote we just rendered. Harmless no-op otherwise.
    const t = setTimeout(() => {
      const w = window as unknown as {
        twttr?: { widgets?: { load?: (el?: Element | null) => void } };
      };
      if (w.twttr?.widgets?.load) w.twttr.widgets.load(containerRef.current);
    }, 300);
    return () => clearTimeout(t);
  }, [resolution]);

  if (resolution.kind === "none") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-10 text-xs text-muted-foreground">
        <p>Not published yet — the Simulated tab shows what this will look like.</p>
      </div>
    );
  }

  if (resolution.kind === "link-only") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border py-10 text-xs text-muted-foreground">
        <p>
          {platform === "linkedin"
            ? "LinkedIn doesn't expose a public embed from the post URL."
            : "No embed available for this platform."}
        </p>
        <a
          href={resolution.href}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open on {platform === "linkedin" ? "LinkedIn" : "source"}
          <ExternalLinkIcon className="ml-1.5 h-3 w-3" />
        </a>
      </div>
    );
  }

  if (resolution.kind === "iframe") {
    const aspectClass =
      resolution.aspect === "portrait"
        ? "aspect-[9/16] max-h-[720px]"
        : resolution.aspect === "square"
          ? "aspect-square"
          : resolution.aspect === "video"
            ? "aspect-video"
            : "aspect-[4/3]";
    return (
      <div className={`w-full max-w-[480px] mx-auto ${aspectClass}`}>
        <iframe
          src={resolution.src}
          className="h-full w-full rounded-md border border-border"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </div>
    );
  }

  // script (X, TikTok) — inject blockquote + load the official widget script.
  return (
    <div
      ref={containerRef}
      className="flex w-full max-w-[480px] mx-auto justify-center"
      dangerouslySetInnerHTML={{ __html: resolution.html }}
    />
  );
}
