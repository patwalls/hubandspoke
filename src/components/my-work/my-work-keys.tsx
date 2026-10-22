"use client";

import { useEffect, useRef } from "react";

/**
 * Keyboard triage for My Work: j / k move between rows with buttons,
 * Enter opens the item, and the key on a row's button (r, a, b) fires it.
 * Rows opt in with `data-my-work-row`; RowActions buttons carry
 * `data-row-key`. Ignored while typing in a field or with a modifier held.
 */
export function MyWorkKeys() {
  const index = useRef(-1);

  useEffect(() => {
    const rows = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-my-work-row]")).filter((r) =>
        r.querySelector("[data-row-key]"),
      );
    const focus = (i: number) => {
      const list = rows();
      if (list.length === 0) return;
      index.current = Math.max(0, Math.min(i, list.length - 1));
      list.forEach((r, n) => r.toggleAttribute("data-focused", n === index.current));
      list[index.current].scrollIntoView({ block: "nearest" });
    };

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const list = rows();
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        focus(index.current + 1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        focus(index.current - 1);
        return;
      }
      const row = list[index.current];
      if (!row || !row.hasAttribute("data-focused")) return;
      if (e.key === "Enter") {
        row.querySelector<HTMLAnchorElement>("a[href]")?.click();
        return;
      }
      const btn = row.querySelector<HTMLButtonElement>(`[data-row-key="${e.key}"]`);
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <p className="text-[11px] text-muted-foreground">
      Keys: <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move ·{" "}
      <kbd className="font-mono">r</kbd> send to review · <kbd className="font-mono">a</kbd> approve ·{" "}
      <kbd className="font-mono">b</kbd> send back · <kbd className="font-mono">Enter</kbd> open
    </p>
  );
}
