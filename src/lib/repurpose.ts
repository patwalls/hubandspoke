/**
 * Given a format's prompt, decide which of the app's repurpose
 * capabilities it's asking for.
 *
 * Today the only capability is Descript clip-out. A prompt opts in by
 * mentioning "descript" or "clip" (case-insensitive). Formats with an
 * empty prompt are intentionally *not* auto-routed to Descript — we
 * want the user to explicitly describe the intent before we spend
 * AI credits on their behalf.
 *
 * As we add more capabilities (e.g. Asana task creation, scheduled
 * social posts), they plug in here by matching their own keywords.
 */
export type RepurposeCapability = "descript-clip" | "none";

export function detectRepurposeCapability(
  prompt: string | null | undefined
): RepurposeCapability {
  if (!prompt) return "none";
  const normalized = prompt.toLowerCase();
  if (normalized.includes("descript") || /\bclip(s|ping|ped)?\b/.test(normalized)) {
    return "descript-clip";
  }
  return "none";
}

export function isDescriptClipEnabled(
  prompt: string | null | undefined
): boolean {
  return detectRepurposeCapability(prompt) === "descript-clip";
}
