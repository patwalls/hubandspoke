"use client";

import { useEffect } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import type { FormatEditorRules } from "@/lib/db/schema";
import { trackUsage } from "@/lib/usage/track";
import { PropertyRowSolo } from "./property-row";

/**
 * "What editors keep changing" (drafts-learn M4): the weekly
 * `format-editor-rules` job's rules for this format, read from recent
 * draft → published rewrites. Each rule can be added to the Skill with one
 * click; the draft agent reads the whole Skill, so it applies to every
 * draft after that. Hidden until the job has written rules.
 */
export function FormatEditorRulesSection({
  rules,
  instructions,
  canEdit,
  brand,
  onAdd,
}: {
  rules: FormatEditorRules | null | undefined;
  instructions: string;
  canEdit: boolean;
  brand: string;
  onAdd: (rule: string) => void;
}) {
  const shown = !!rules && rules.rules.length > 0;
  useEffect(() => {
    if (shown) trackUsage("formats:editor-rules", brand);
  }, [shown, brand]);
  if (!shown) return null;

  const inSkill = (rule: string) => instructions.toLowerCase().includes(rule.toLowerCase());
  const updated = new Date(rules.generatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <PropertyRowSolo>
      <div className="px-3 py-3 space-y-2" data-testid="format-editor-rules">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">What editors keep changing</span>
          <span className="text-xs text-muted-foreground">
            From {rules.pairCount} recent rewrites · {updated}
          </span>
        </div>
        <ul className="space-y-1.5">
          {rules.rules.map((rule) => {
            const added = inSkill(rule);
            return (
              <li key={rule} className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 px-2.5 py-1.5">
                <span className="text-sm">{rule}</span>
                {added ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-emerald-700">
                    <CheckIcon className="size-3" /> In Skill
                  </span>
                ) : canEdit ? (
                  <button
                    type="button"
                    onClick={() => {
                      trackUsage("formats:editor-rules:add", brand);
                      onAdd(rule);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <PlusIcon className="size-3" /> Add to Skill
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          Read weekly from AI drafts and copied captions editors rewrote before publishing. Drafts already see the latest rewrites; a rule added to the Skill applies to every draft from then on.
        </p>
      </div>
    </PropertyRowSolo>
  );
}
