"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type MentionUser = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
};

export type MentionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type Props = {
  items: MentionUser[];
  command: (item: { id: string; label: string }) => void;
};

function displayName(u: MentionUser): string {
  if (u.name && u.name.trim()) return u.name;
  return u.email.split("@")[0] ?? u.email;
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name[0] ?? "?").toUpperCase();
}

export const MentionList = forwardRef<MentionListRef, Props>(
  function MentionList({ items, command }, ref) {
    const [index, setIndex] = useState(0);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => setIndex(0), [items]);

    useLayoutEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-mention-index="${index}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }, [index]);

    const select = (i: number) => {
      const item = items[i];
      if (!item) return;
      command({ id: item.id, label: displayName(item) });
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === "ArrowDown") {
          setIndex((i) => (i + 1) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === "ArrowUp") {
          setIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          select(index);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="min-w-[200px] rounded-md border border-border bg-popover shadow-md text-xs text-muted-foreground px-3 py-2">
          No matches
        </div>
      );
    }

    return (
      <div
        ref={listRef}
        className="min-w-[220px] max-h-[240px] overflow-auto rounded-md border border-border bg-popover shadow-md py-1"
      >
        {items.map((u, i) => {
          const name = displayName(u);
          return (
            <button
              type="button"
              key={u.id}
              data-mention-index={i}
              onMouseDown={(e) => {
                e.preventDefault();
                select(i);
              }}
              onMouseEnter={() => setIndex(i)}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm",
                i === index ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              {u.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={u.avatarUrl}
                  alt=""
                  className="size-6 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="size-6 rounded-full bg-accent text-muted-foreground text-[10px] font-medium inline-flex items-center justify-center shrink-0">
                  {initialsFor(name)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {u.email}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    );
  },
);
