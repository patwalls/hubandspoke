/** Formats the design editor knows how to draft — everything else keeps the
 *  classic triage dialog. Pure (client-safe); the server reads it too. */
export const DESIGN_TEMPLATES: Record<string, "playbook"> = {
  "Instagram PLAYBOOK": "playbook",
};

export function hasDesignTemplate(format: string | null | undefined): boolean {
  return !!format && format in DESIGN_TEMPLATES;
}
