"use client";

import { cn } from "@/lib/utils";
import { MonogramAvatar } from "./avatar";
import { EditableField } from "./editable-field";
import { VerifiedBadge } from "./verified-badge";
import type { PreviewData } from "./resolve-preview-data";
import type { SimulatorProps } from "./simulator-types";
import { PLATFORM_FONT } from "./platform-tokens";

// The secondary post that lives under a draft on platforms with a native
// CTA slot — reply tweet (X), first comment (LinkedIn), pinned comment
// (YouTube Community). It edits a single longtext draft field via the same
// blur-commit machinery the main caption uses; no new API surface.
//
// Each platform has its own visual chrome. The shared shape (avatar +
// header + editable body + char counter) is rendered by this component;
// per-platform layout differences are inlined per `variant` rather than
// hidden behind extra abstraction.
export type CtaVariant = "x" | "linkedin" | "youtube_community";

interface Props {
  variant: CtaVariant;
  fieldKey: string;
  value: string;
  editable: boolean;
  onLocalEdit?: SimulatorProps["onLocalEdit"];
  onCommit?: SimulatorProps["onCommit"];
  author: PreviewData["author"];
  maxLength?: number;
}

export function CtaCard({
  variant,
  fieldKey,
  value,
  editable,
  onLocalEdit,
  onCommit,
  author,
  maxLength,
}: Props) {
  if (variant === "x") return <XCta {...{ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }} />;
  if (variant === "linkedin") return <LinkedInCta {...{ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }} />;
  return <YouTubeCommunityCta {...{ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }} />;
}

interface VariantProps {
  fieldKey: string;
  value: string;
  editable: boolean;
  onLocalEdit?: SimulatorProps["onLocalEdit"];
  onCommit?: SimulatorProps["onCommit"];
  author: PreviewData["author"];
  maxLength?: number;
}

// X reply: stacked under the main tweet with a vertical connector line on
// the left between the two avatars (mirrors the Typefully second-tweet
// reference). Same author as the main tweet — replies-from-self are how
// "tweet a CTA reply" actually publishes on X.
function XCta({ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }: VariantProps) {
  const displayName = author.displayName ?? author.handle ?? "You";
  return (
    <div
      className="mx-auto flex w-full max-w-[560px] gap-3"
      style={{ fontFamily: PLATFORM_FONT.x }}
    >
      <div className="flex flex-col items-center">
        <div className="-mt-3 h-3 w-px bg-border" />
        <MonogramAvatar
          displayName={author.displayName}
          handle={author.handle}
          avatarUrl={author.avatarUrl}
          size="md"
        />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-semibold">{displayName}</span>
          {author.verified && <VerifiedBadge />}
          {author.handle && (
            <span className="truncate text-xs text-muted-foreground">
              @{author.handle}
            </span>
          )}
        </div>
        <div className="mt-0.5 mb-1 text-[11px] text-muted-foreground">
          Replying to {author.handle ? `@${author.handle}` : "yourself"}
        </div>
        <EditableField
          fieldKey={fieldKey}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={value}
          placeholder="Add a reply with the CTA…"
          multiline
          className="whitespace-pre-wrap text-sm leading-snug text-foreground"
          maxLength={maxLength}
        />
        <CharCounter value={value} maxLength={maxLength} />
      </div>
    </div>
  );
}

// LinkedIn first comment: indented chip below the post, with an "Author"
// pill so editors immediately see this is the author's own pinned comment
// (the convention LI uses to surface the link CTA without burying it in
// the body and tanking reach).
function LinkedInCta({ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }: VariantProps) {
  const displayName = author.displayName ?? author.handle ?? "You";
  return (
    <div
      className="mx-auto w-full max-w-[560px] pl-10"
      style={{ fontFamily: PLATFORM_FONT.linkedin }}
    >
      <div className="rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <MonogramAvatar
            displayName={author.displayName}
            handle={author.handle}
            avatarUrl={author.avatarUrl}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold">
                {displayName}
              </span>
              <span className="rounded-sm bg-muted px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Author
              </span>
            </div>
            {author.bio && (
              <div className="truncate text-[11px] leading-tight text-muted-foreground">
                {author.bio}
              </div>
            )}
            <div className="mt-1.5">
              <EditableField
                fieldKey={fieldKey}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                value={value}
                placeholder="Pin a comment with the CTA…"
                multiline
                className="whitespace-pre-wrap text-[13px] leading-snug text-foreground"
                maxLength={maxLength}
              />
              <CharCounter value={value} maxLength={maxLength} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// YouTube Community pinned comment: smaller comment block under the post
// with a 📌 Pinned pill. v1 always shows the pill — the actual pin state
// is implicit (the freelancer pins it manually after publish). A pin
// toggle is a v2 follow-up.
function YouTubeCommunityCta({ fieldKey, value, editable, onLocalEdit, onCommit, author, maxLength }: VariantProps) {
  const displayName = author.displayName ?? author.handle ?? "Channel";
  return (
    <div
      className="mx-auto w-full max-w-[640px] border-t border-[#e5e5e5] px-4 pt-3"
      style={{ fontFamily: PLATFORM_FONT.youtube_community }}
    >
      <div className="mb-2 inline-flex items-center gap-1 rounded-full bg-[#f2f2f2] px-2 py-0.5 text-[11px] font-medium text-[#0f0f0f]">
        <PinIcon />
        Pinned by {displayName}
      </div>
      <div className="flex items-start gap-2.5">
        <MonogramAvatar
          displayName={author.displayName}
          handle={author.handle}
          avatarUrl={author.avatarUrl}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[#0f0f0f]">
              {displayName}
            </span>
            <span className="text-[11px] text-[#606060]">Author</span>
          </div>
          <div className="mt-1">
            <EditableField
              fieldKey={fieldKey}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={value}
              placeholder="Add a pinned comment with the CTA…"
              multiline
              className="whitespace-pre-wrap text-[13px] leading-[1.45] text-[#0f0f0f]"
              maxLength={maxLength}
            />
            <CharCounter value={value} maxLength={maxLength} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CharCounter({
  value,
  maxLength,
}: {
  value: string;
  maxLength?: number;
}) {
  if (!maxLength) return null;
  const len = value.length;
  const over = len > maxLength;
  return (
    <div
      className={cn(
        "mt-1 text-right text-[10px] tabular-nums",
        over ? "text-red-500" : "text-muted-foreground",
      )}
    >
      {len}/{maxLength}
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden>
      <path d="M14 4l6 6-4 1-3 3 1 5-7-7-5 1 3-3-1-5 4-1z" />
    </svg>
  );
}
