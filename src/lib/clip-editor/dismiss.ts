/**
 * When a full-screen editor (clip or design) is allowed to close itself.
 *
 * The editors live in a dialog, and a dialog closes on Esc and on a press
 * outside it by default. For an editor that is wrong twice over: the strip
 * around it is a few pixels wide (a missed click on the timeline's edge lands
 * there), and Esc is what people press to let go of a selection. Either one
 * closed the whole editor, and reopening reloads the source video.
 *
 * Rules: a press outside (or focus leaving) never closes an editor. Esc lets
 * go of one thing at a time — the field you're typing in, then highlighted
 * transcript words, then the layer picked on the stage — and closes the editor
 * only when there is nothing left to let go of (so Esc-to-close still works).
 */

/** Base UI's close reasons that must not close an editor. */
const STRAY_REASONS = new Set(["outside-press", "focus-out"]);

export function editorIgnoresClose(reason: string): boolean {
  return STRAY_REASONS.has(reason);
}

export type EditorEscapeStep = "leave-field" | "drop-words" | "drop-layer" | "close";

export function editorEscapeStep(state: {
  typing: boolean;
  wordSelection: boolean;
  stageSelection: boolean;
}): EditorEscapeStep {
  if (state.typing) return "leave-field";
  if (state.wordSelection) return "drop-words";
  if (state.stageSelection) return "drop-layer";
  return "close";
}

/** Whether the focused element takes typing (Esc there means "leave the field"). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}
