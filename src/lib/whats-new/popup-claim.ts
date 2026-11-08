import { POPUP_COOLDOWN_HOURS } from "./index";

/**
 * The What's new pop-up, once per browser per day — not once per tab.
 *
 * The server decides "pop up" from `users.whats_new_seen_at`, which is only
 * stamped when the pop-up is dismissed. So a person who opens five posts in
 * five tabs at once got five pop-ups, and one who left it open and moved on
 * got it again on every page load (usage showed up to 6 a day for one person,
 * all seconds apart). The first tab to show it now leaves a claim in
 * localStorage; any other tab or load within the cooldown stays quiet. The
 * full list is still one click away in the Learn menu.
 */
export const POPUP_CLAIM_KEY = "whats-new:popup-shown-at";

/** Should this page load show the pop-up, given the claim another load left? */
export function shouldShowPopup(claimRaw: string | null, now: number): boolean {
  if (!claimRaw) return true;
  const at = Number(claimRaw);
  // Garbage, or a clock that moved backwards: don't let it silence the pop-up forever.
  if (!Number.isFinite(at) || at > now) return true;
  return now - at >= POPUP_COOLDOWN_HOURS * 3_600_000;
}

/**
 * Claim the pop-up for this tab if no other tab or load has today.
 * Fail-open: without localStorage (private mode, blocked storage) every load
 * decides alone, as before.
 */
export function claimPopup(now: number = Date.now()): boolean {
  try {
    if (!shouldShowPopup(window.localStorage.getItem(POPUP_CLAIM_KEY), now)) return false;
    window.localStorage.setItem(POPUP_CLAIM_KEY, String(now));
  } catch {
    // fall through: show it
  }
  return true;
}
