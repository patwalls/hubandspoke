import type { ContentDraftContent } from "@/lib/db/schema";
import type { PlatformFieldMap, PreviewData } from "./resolve-preview-data";

export interface SimulatorProps {
  data: PreviewData;
  // Which draft field keys back the editable spots in this platform's mock.
  fieldMap: PlatformFieldMap;
  // True when we have a writable draft; false for POC on a published item.
  editable: boolean;
  // Live content mirrors the current draft; simulators read their caption/
  // secondary values from here (NOT from `data`, which is a snapshot resolved
  // once). Falls back to `data.caption` / `data.secondaryText` when a key is
  // absent.
  liveContent: ContentDraftContent | null;
  onLocalEdit?: (fieldKey: string, value: string) => void;
  onCommit?: (fieldKey: string) => void;
}

export function readLive(
  liveContent: ContentDraftContent | null,
  fieldKey: string | null,
  fallback: string,
): string {
  if (!fieldKey || !liveContent) return fallback;
  const v = liveContent[fieldKey];
  if (typeof v === "string") return v;
  return fallback;
}
