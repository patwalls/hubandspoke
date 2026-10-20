// The newsletter drafter's sponsored section ("The Special" in Sunday
// Breakfast), pulled from the brand's promo-calendar Asana project instead of
// written by the agent. The agent leaves SPECIAL_MARKER where the section
// goes; the page and the HubSpot push swap in the stored copy, so the editor
// can keep the copy exactly as written or rewrite it without redrafting.
//
// Which task: the project's task in PROMO section whose due date is the
// issue's send date. Which copy: the task's "Final Newsletter Copy" subtask
// description when it exists (the process the promo team is adopting), else
// the form's "What should we focus on in the ad copy?" answer — a pilot
// placeholder until the subtask exists on every task.

import { getSubtasks, getTask, listProjectTasks, parseAsanaFormNotes, type AsanaSubtask, type AsanaTaskSummary } from "@/lib/asana";
import type { NewsletterSpecialSource } from "@/lib/db/schema";

export { SPECIAL_MARKER, composeBody, composeSpecialBlock } from "./special-compose";

export const FINAL_COPY_SUBTASK = "Final Newsletter Copy";
const FOCUS_QUESTION = "What should we focus on in the ad copy?";
const LANDING_QUESTION = "Which landing page URL should we use?";

interface PromoCalendar {
  projectGid: string;
  section: string;
}

/** Newsletter formats whose sponsored section comes from Asana, by format name (lowercase). */
const PROMO_CALENDARS: Record<string, PromoCalendar> = {
  // MEDIA | Starter Story Promo Calendar → one "Native Ad" task per Sunday.
  "sunday breakfast": { projectGid: "1213468297418521", section: "Native Ad" },
};

export function promoCalendarFor(formatName: string): PromoCalendar | null {
  return PROMO_CALENDARS[formatName.trim().toLowerCase()] ?? null;
}

/** The task for `sendDate` (YYYY-MM-DD) in `section`. Exported for tests. */
export function pickPromoTask(tasks: AsanaTaskSummary[], sendDate: string, section: string): AsanaTaskSummary | null {
  return (
    tasks.find(
      (t) => t.due_on === sendDate && (t.memberships ?? []).some((m) => m.section?.name === section),
    ) ?? null
  );
}

/** The copy + landing URL from a promo task. Exported for tests. */
export function extractSpecial(
  notes: string,
  subtasks: AsanaSubtask[],
): { copy: string; landingUrl: string | null; copyFrom: NewsletterSpecialSource["copyFrom"] } | null {
  const form = parseAsanaFormNotes(notes);
  const landingUrl = form[LANDING_QUESTION]?.split(/\s/)[0] || null;
  const sub = subtasks.find((s) => s.name.trim().toLowerCase() === FINAL_COPY_SUBTASK.toLowerCase());
  if (sub?.notes.trim()) return { copy: sub.notes.trim(), landingUrl, copyFrom: "subtask" };
  const focus = form[FOCUS_QUESTION]?.trim();
  if (focus) return { copy: focus, landingUrl, copyFrom: "focus_field" };
  return null;
}

export type SpecialLookup =
  | { ok: true; copy: string; source: NewsletterSpecialSource }
  | { ok: false; error: string };

/** Look up the promo for a format + send date. null = this format has no promo calendar. */
export async function findSpecial(formatName: string, sendDate: string | null): Promise<SpecialLookup | null> {
  const cal = promoCalendarFor(formatName);
  if (!cal) return null;
  if (!sendDate) return { ok: false, error: "No send date set, so no promo was looked up." };
  try {
    // Include tasks completed up to 60 days before the send date — promo tasks
    // can be checked off before the issue goes out.
    const since = new Date(Date.parse(`${sendDate}T00:00:00Z`) - 60 * 24 * 60 * 60 * 1000).toISOString();
    const task = pickPromoTask(await listProjectTasks(cal.projectGid, since), sendDate, cal.section);
    if (!task) return { ok: false, error: `No "${cal.section}" promo task in Asana is due ${sendDate}.` };
    const [detail, subtasks] = await Promise.all([getTask(task.gid), getSubtasks(task.gid)]);
    const special = extractSpecial(detail.notes, subtasks);
    if (!special) {
      return { ok: false, error: `The Asana task "${detail.name}" has no "${FINAL_COPY_SUBTASK}" subtask and no ad-copy focus.` };
    }
    return {
      ok: true,
      copy: special.copy,
      source: {
        taskGid: detail.gid,
        taskName: detail.name,
        taskUrl: detail.permalink_url,
        landingUrl: special.landingUrl,
        copyFrom: special.copyFrom,
      },
    };
  } catch (err) {
    return { ok: false, error: `Asana lookup failed: ${(err as Error).message}` };
  }
}
