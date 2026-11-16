"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface QueueTabKeyEntry {
  label: string;
  hint: string;
}

/**
 * The small "?" beside the Queue heading: click it for a compact key of what
 * each tab holds — one short line per tab. Out of the way on purpose: people
 * who live in the queue never see it unless they ask.
 */
export function QueueTabKey({ entries }: { entries: QueueTabKeyEntry[] }) {
  return (
    <Popover>
      <PopoverTrigger
        className="ml-2 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border align-middle text-[11px] font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
        aria-label="What the queue tabs mean"
      >
        ?
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3" data-testid="queue-tab-key">
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-xs">
          {entries.map((e) => (
            <div key={e.label} className="contents">
              <dt className="font-medium text-foreground whitespace-nowrap">{e.label}</dt>
              <dd className="text-muted-foreground whitespace-nowrap">{e.hint}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
