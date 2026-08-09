/**
 * Pure helper split out of comment-editor.tsx so consumers can check
 * emptiness WITHOUT statically importing the editor module — that import
 * pulls the entire TipTap/ProseMirror bundle (~900 KB chunk) onto the
 * critical path. content-activity dynamic()s the editor and imports this
 * instead.
 */
const EMPTY_HTML_RE = /^(\s|<p>\s*<\/p>|<br\s*\/?>)*$/i;

export function isEditorEmpty(html: string): boolean {
  return EMPTY_HTML_RE.test(html);
}
