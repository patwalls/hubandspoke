"use client";

import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function NewsletterSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const subject = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  const displayName = data.author.displayName ?? data.author.handle ?? "You";

  return (
    <div className="mx-auto w-full max-w-[600px] overflow-hidden rounded-md border border-border bg-background text-foreground">
      {/* Email header */}
      <div className="border-b border-border bg-muted/40 px-4 py-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          Inbox · from {displayName}
        </div>
        <EditableField
          fieldKey={fieldMap.secondary}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={subject}
          placeholder="Subject line…"
          multiline={false}
          className="text-base font-semibold leading-snug"
        />
      </div>

      <div className="flex items-start gap-3 px-4 pt-3">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{displayName}</div>
          <div className="text-xs text-muted-foreground">
            to me · {data.publishedAt ? new Date(data.publishedAt).toLocaleDateString() : "now"}
          </div>
        </div>
      </div>

      <div className="px-4 pb-5 pt-4 text-[14px] leading-relaxed">
        <EditableField
          fieldKey={fieldMap.caption}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={body}
          placeholder="Body copy…"
          multiline
          className="text-[14px] leading-relaxed"
        />
      </div>
    </div>
  );
}
