import type { Session } from "next-auth";

/**
 * Who can add, edit, reorder and delete Academy content. Everyone signed in
 * can watch; only these accounts can change it (decision 2026-11-05: Sam,
 * Pat, Evgeny). To add an editor, add their Hub & Spoke login email here.
 */
export const ACADEMY_EDITOR_EMAILS = [
  "sam@starterstory.com", // Sam
  "samanthawalls23@gmail.com", // Sam's test account
  "patrickswalls@gmail.com", // Pat
  "timjohn2002@gmail.com", // Evgeny
] as const;

// The local e2e login can edit in development so the Academy can be tried
// end-to-end on localhost; it is never an editor in production.
const LOCAL_ONLY_EDITORS = process.env.NODE_ENV === "production" ? [] : ["e2e@local.test"];

const EDITORS = new Set<string>([...ACADEMY_EDITOR_EMAILS, ...LOCAL_ONLY_EDITORS]);

export function isAcademyEditor(session: Session | null | undefined): boolean {
  const email = session?.user?.email?.trim().toLowerCase();
  return !!email && EDITORS.has(email);
}
