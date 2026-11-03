"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { firstName, pickHandoff, type HandoffPerson } from "@/lib/handoff/pick";
import { trackUsage } from "@/lib/usage/track";
import { cn } from "@/lib/utils";
import { useCanEditBrand } from "@/components/brand-access";

interface HandoffData {
  me: string | null;
  reviewers: HandoffPerson[];
  sentToReviewBy: HandoffPerson | null;
}

const BTN =
  "inline-flex h-7 items-center gap-1 border border-primary/30 bg-primary/5 px-2 text-xs font-medium text-primary hover:bg-primary/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/**
 * "Send to review → Andrew" / "Approve → back to John" next to the status
 * chip: status + editor in one click instead of two (rules in
 * src/lib/handoff/pick.ts). After a move to Review from the status menu that
 * left the editor holding it: "Hand to Andrew for review" (editor only).
 * `onHandoff` saves through the content page's own PUT, so events and the new
 * editor's notification are unchanged. `refreshKey` changes once a status
 * save has landed, so "who sent it to review" is read after the save, not
 * racing it.
 */
export function HandoffButton({
  itemId,
  brand,
  status,
  editorUserId,
  brandStatuses,
  onHandoff,
  refreshKey,
}: {
  itemId: string;
  brand: string;
  status: string;
  editorUserId: string;
  brandStatuses: ReadonlySet<string>;
  onHandoff: (patch: { status: string; editorUserId: string }) => Promise<boolean>;
  refreshKey?: string | number;
}) {
  const [data, setData] = useState<HandoffData | null>(null);
  const [busy, setBusy] = useState(false);
  // View-only users can't hand off (it's a status + editor change).
  const canEdit = useCanEditBrand(brand);
  const relevant = canEdit && (status === "Assigned" || status === "Review");

  // Refetch on status change: "who sent it to review" moves with it.
  useEffect(() => {
    if (!relevant) return;
    let cancelled = false;
    fetch(`/api/production-items/${itemId}/handoff`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: HandoffData | null) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, status, relevant, refreshKey]);

  if (!relevant || !data?.me) return null;
  const handoff = pickHandoff({
    me: data.me,
    status,
    editorUserId: editorUserId || null,
    brandStatuses,
    reviewers: data.reviewers,
    sentToReviewBy: data.sentToReviewBy,
  });
  if (!handoff) return null;

  async function go(person: HandoffPerson) {
    if (!handoff) return;
    setBusy(true);
    trackUsage(keepsEditor ? "handoff:approve-kept-editor" : `handoff:${handoff.kind}`, brand);
    await onHandoff({ status: handoff.to, editorUserId: person.id });
    setBusy(false);
  }

  // Approve on a post the sender already holds again (the reviewer set the
  // editor first): only the status moves.
  const keepsEditor = handoff.kind === "approve" && handoff.person.id === editorUserId;
  const label =
    handoff.kind === "send-to-review"
      ? `Send to review → ${firstName(handoff.person.name)}`
      : handoff.kind === "name-reviewer"
        ? `Hand to ${firstName(handoff.person.name)} for review`
        : keepsEditor
        ? `Approve → ${handoff.to}`
        : `Approve → back to ${firstName(handoff.person.name)}`;
  const hasMore = handoff.others.length > 0;

  return (
    <span className="inline-flex items-center" data-testid="handoff">
      <button
        type="button"
        disabled={busy}
        onClick={() => void go(handoff.person)}
        title={
          handoff.kind === "send-to-review"
            ? `Moves it to ${handoff.to} and makes ${handoff.person.name} the editor`
            : handoff.kind === "name-reviewer"
              ? `It's in ${handoff.to} but still yours: makes ${handoff.person.name} the editor so they know it's waiting`
              : keepsEditor
              ? `Moves it to ${handoff.to}; ${handoff.person.name} stays the editor`
              : `Moves it to ${handoff.to} and gives it back to ${handoff.person.name}`
        }
        className={cn(BTN, hasMore ? "rounded-l-md" : "rounded-md")}
      >
        {label}
      </button>
      {hasMore && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            aria-label="Send to someone else"
            className={cn(BTN, "rounded-r-md border-l-0 px-1")}
          >
            <ChevronDownIcon className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{handoff.kind === "name-reviewer" ? "Hand for review →" : "Send to review →"}</DropdownMenuLabel>
              {handoff.others.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => void go(p)}>
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}
