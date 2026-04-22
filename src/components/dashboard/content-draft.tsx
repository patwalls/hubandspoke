"use client";

import { useCallback, useState } from "react";
import { SparklesIcon } from "lucide-react";
import type { ContentDraftContent, FormatFieldSchema } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// The server returns contentDrafts rows with `createdAt`/`updatedAt` as ISO
// strings. Keep a local shape here rather than importing the Drizzle row type
// (which has Date objects) — the component only ever sees the JSON shape.
export interface DraftRow {
  id: string;
  productionItemId: string;
  version: number;
  isCurrent: boolean;
  content: ContentDraftContent;
  fieldSchemaSnapshot: FormatFieldSchema;
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type FieldSaveState = "idle" | "saving" | "saved" | "error";

interface ContentDraftPanelProps {
  itemId: string;
  hasFieldSchema: boolean;
  formatName: string | null;
  draft: DraftRow | null;
  liveContent: ContentDraftContent | null;
  fieldSaves: Record<string, FieldSaveState>;
  fieldErrors: Record<string, string>;
  onLocalEdit: (fieldKey: string, value: string | string[]) => void;
  onCommit: (fieldKey: string) => void;
  onDraftReplaced: (draft: DraftRow) => void;
}

type FieldType = FormatFieldSchema["fields"][number]["type"];

function countBy(type: FieldType): FieldType {
  return type;
}

// Stage 1 only renders text + longtext fields inline. Tags/slides get a muted
// placeholder so editors know those values came through from the agent but
// need the Stage 2 renderer to edit.
function UnsupportedFieldPlaceholder({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  const count =
    Array.isArray(value) ? value.length : typeof value === "string" ? 1 : 0;
  return (
    <div className="rounded-md border border-dashed border-border bg-accent/30 px-3 py-2 text-xs text-muted-foreground">
      {count > 0
        ? `${label}: ${count} item${count === 1 ? "" : "s"} generated — editor ships in Stage 2.`
        : `${label}: editor ships in Stage 2.`}
    </div>
  );
}

export function ContentDraftPanel({
  itemId,
  hasFieldSchema,
  formatName,
  draft,
  liveContent,
  fieldSaves,
  fieldErrors,
  onLocalEdit,
  onCommit,
  onDraftReplaced,
}: ContentDraftPanelProps) {
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/drafts/generate`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      onDraftReplaced(json.draft as DraftRow);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [itemId, onDraftReplaced]);

  const fields = draft?.fieldSchemaSnapshot.fields ?? [];

  function readString(fieldKey: string): string {
    const v = liveContent?.[fieldKey];
    return typeof v === "string" ? v : "";
  }

  function readTags(fieldKey: string): string[] {
    const v = liveContent?.[fieldKey];
    return Array.isArray(v)
      ? (v as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  }

  function renderField(field: (typeof fields)[number]) {
    const saveState = fieldSaves[field.key] ?? "idle";
    const error = fieldErrors[field.key];
    const label = (
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground">
          {field.label}
          {field.required && (
            <span className="text-destructive ml-0.5">*</span>
          )}
        </label>
        <div className="flex items-center gap-2 text-[11px]">
          {field.maxLength && (
            <span
              className={
                readString(field.key).length > field.maxLength
                  ? "text-destructive tabular-nums"
                  : "text-muted-foreground tabular-nums"
              }
            >
              {readString(field.key).length}/{field.maxLength}
            </span>
          )}
          {saveState === "saving" && (
            <span className="text-muted-foreground">Saving…</span>
          )}
          {saveState === "saved" && (
            <span className="text-emerald-600">Saved</span>
          )}
          {saveState === "error" && error && (
            <span className="text-destructive" title={error}>
              Save failed
            </span>
          )}
        </div>
      </div>
    );

    switch (countBy(field.type)) {
      case "text": {
        const value = readString(field.key);
        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            {label}
            <Input
              value={value}
              onChange={(e) => onLocalEdit(field.key, e.target.value)}
              onBlur={() => onCommit(field.key)}
            />
          </div>
        );
      }
      case "longtext": {
        const value = readString(field.key);
        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            {label}
            <Textarea
              value={value}
              rows={field.maxLength && field.maxLength <= 300 ? 3 : 6}
              onChange={(e) => onLocalEdit(field.key, e.target.value)}
              onBlur={() => onCommit(field.key)}
            />
          </div>
        );
      }
      case "tags":
      case "slides":
        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            {label}
            <UnsupportedFieldPlaceholder
              label={field.type === "slides" ? "Slides" : "Tags"}
              value={
                field.type === "tags"
                  ? readTags(field.key)
                  : liveContent?.[field.key]
              }
            />
          </div>
        );
    }
  }

  const generateLabel = draft ? "Regenerate" : "Generate draft";
  const disableGenerate = generating || !hasFieldSchema;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground inline-flex items-center gap-2">
            <SparklesIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Draft
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Platform-specific copy for {formatName ?? "this format"}. AI-drafted
            from the pillar transcript; edits save automatically.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerate}
            disabled={disableGenerate}
          >
            <SparklesIcon className="mr-1.5 h-3 w-3" />
            {generating ? "Generating…" : generateLabel}
          </Button>
          {draft && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              v{draft.version} · {draft.generatedBy}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 sm:px-5 py-4 flex flex-col gap-4">
        {!hasFieldSchema && (
          <p className="text-xs text-muted-foreground">
            This format has no field schema yet. Run{" "}
            <code className="text-[11px]">scripts/seed-format-field-schemas.mjs</code>
            {" "}or define one on the format.
          </p>
        )}
        {generateError && (
          <p className="text-xs text-destructive">{generateError}</p>
        )}
        {!draft && hasFieldSchema && (
          <p className="text-xs text-muted-foreground">
            No draft yet — click <strong>Generate draft</strong> to create one.
          </p>
        )}
        {fields.map((f) => renderField(f))}
      </div>
    </div>
  );
}
