/**
 * Last line of defence for unsaved edits: a localStorage copy of the doc,
 * kept only while the server DOESN'T have it (dirty / saving / save failed).
 *
 * Autosave already persists every edit within a second, so this only matters
 * when that path fails — offline, a 500, the tab killed mid-request. On the
 * next open, a backup is restored only if it was made on top of the exact
 * revision the server still has; if the server has moved on (you kept
 * editing elsewhere), the server wins and the backup is dropped.
 */
import { parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";

const key = (clipIdeaId: string) => `hs:clip-editor:backup:${clipIdeaId}`;

interface Backup {
  baseRevision: number;
  doc: unknown;
  at: number;
}

export function writeBackup(clipIdeaId: string, baseRevision: number, doc: ClipEditDoc): void {
  try {
    const payload: Backup = { baseRevision, doc, at: Date.now() };
    window.localStorage.setItem(key(clipIdeaId), JSON.stringify(payload));
  } catch {
    // Quota / private mode — the backup is best-effort by definition.
  }
}

export function clearBackup(clipIdeaId: string): void {
  try {
    window.localStorage.removeItem(key(clipIdeaId));
  } catch {
    // ignore
  }
}

/** The doc to recover, or null. Always clears a backup it won't use. */
export function takeBackup(
  clipIdeaId: string,
  serverRevision: number,
  serverDoc: ClipEditDoc,
): ClipEditDoc | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key(clipIdeaId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const backup = JSON.parse(raw) as Backup;
    const parsed = parseDoc(backup.doc);
    // Compare both sides AFTER parsing: zod emits keys in schema order, so a
    // raw stringify of the same document can differ from its parsed form.
    const canonicalServer = parseDoc(serverDoc);
    const usable =
      backup.baseRevision === serverRevision &&
      parsed.ok &&
      canonicalServer.ok &&
      JSON.stringify(parsed.doc) !== JSON.stringify(canonicalServer.doc);
    if (usable && parsed.ok) return parsed.doc;
  } catch {
    // corrupt → fall through and clear
  }
  clearBackup(clipIdeaId);
  return null;
}
