/**
 * Edit a format's clip LOOK without a clip: a stand-in document (the default
 * layout with a placeholder hook, the look applied on top) and a made-up
 * transcript so the captions layer has words to show. What the format page's
 * "Edit look" opens; `lookFromDoc` turns the edited doc back into the look.
 *
 * The placeholder hook text never reaches a real clip: `applyLook` keeps
 * each clip's own hook text (its AI hook) and takes only the style and
 * position from the look.
 */
import { applyLook, createDefaultDoc, type AspectRatio, type ClipEditDoc, type ClipLook } from "./doc";
import type { EditorWord } from "./words";

export const SAMPLE_HOOK = "Your hook goes here — every clip gets its own";

const SAMPLE_CAPTIONS =
  "This is how the captions will look on every clip of this format. Each cue shows a few words at a time while the guest is talking, so you can check the font, the size and where they sit.";

/** ~3 words a second, like real speech; starts at 0 so the first cue shows on open. */
export const SAMPLE_WORDS: EditorWord[] = SAMPLE_CAPTIONS.split(" ").map((text, index) => ({
  index,
  text,
  startSec: index * 0.33,
  endSec: index * 0.33 + 0.3,
}));

const SAMPLE_DURATION_SEC = SAMPLE_WORDS[SAMPLE_WORDS.length - 1].endSec;

export function buildLookPreviewDoc(look: ClipLook | null, aspectRatio: AspectRatio = "9:16"): ClipEditDoc {
  const doc = createDefaultDoc({ startSec: 0, endSec: SAMPLE_DURATION_SEC, hook: SAMPLE_HOOK, aspectRatio });
  if (!look) return doc;
  // applyLook fits the hook's size down to the clip's text; here the text is
  // only a placeholder, so keep the look's own hook style exactly — otherwise
  // saving would quietly shrink every format's hook.
  const applied = applyLook(doc, look);
  return {
    ...applied,
    layers: applied.layers.map((l) => {
      const original = look.layers.find((o) => o.id === l.id);
      return l.type === "text" && l.role === "hook" && original?.type === "text" ? { ...l, style: original.style } : l;
    }),
  };
}
