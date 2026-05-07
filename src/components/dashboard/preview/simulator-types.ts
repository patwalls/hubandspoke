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
  // The production_items.id this simulator is rendering. Powers the media
  // drop zone (uploads / deletes are scoped per item).
  itemId: string;
  // Fires after a successful media upload or delete so the parent can
  // refetch and re-render with the new rows.
  onMediaMutated?: () => void;
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
