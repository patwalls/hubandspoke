"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "hubspoke:recent-items:v1";
const MAX_ITEMS = 100;

export type RecentItemKind = "content" | "format";

export type RecentItem = {
  kind: RecentItemKind;
  id: string;
  title: string;
  subtitle?: string;
  brand: string;
  href: string;
  lastVisitedAt: number;
  visitCount: number;
};

export type RecordVisitInput = Omit<RecentItem, "lastVisitedAt" | "visitCount">;

function readStorage(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentItem);
  } catch {
    return [];
  }
}

function isRecentItem(value: unknown): value is RecentItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "content" || v.kind === "format") &&
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.brand === "string" &&
    typeof v.href === "string" &&
    typeof v.lastVisitedAt === "number" &&
    typeof v.visitCount === "number"
  );
}

const listeners = new Set<() => void>();
let cache: RecentItem[] | null = null;

function getSnapshot(): RecentItem[] {
  if (cache === null) cache = readStorage();
  return cache;
}

function getServerSnapshot(): RecentItem[] {
  return EMPTY;
}

const EMPTY: RecentItem[] = [];

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = readStorage();
      notify();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function recordVisit(input: RecordVisitInput): void {
  if (typeof window === "undefined") return;
  const current = readStorage();
  const now = Date.now();
  const existingIdx = current.findIndex(
    (item) => item.kind === input.kind && item.id === input.id,
  );

  let next: RecentItem[];
  if (existingIdx >= 0) {
    const existing = current[existingIdx]!;
    const updated: RecentItem = {
      ...existing,
      ...input,
      lastVisitedAt: now,
      visitCount: existing.visitCount + 1,
    };
    next = [updated, ...current.slice(0, existingIdx), ...current.slice(existingIdx + 1)];
  } else {
    const created: RecentItem = { ...input, lastVisitedAt: now, visitCount: 1 };
    next = [created, ...current];
  }

  if (next.length > MAX_ITEMS) {
    // Drop lowest-scored entries (low visitCount, then oldest).
    next = next
      .slice()
      .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_ITEMS);
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota errors: ignore; recents are a convenience.
  }
  cache = next;
  notify();
}

function useAllItems(): RecentItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useRecents(brand: string, limit = 5): RecentItem[] {
  const items = useAllItems();
  return items
    .filter((item) => item.brand === brand)
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, limit);
}

export function useFrequent(brand: string, limit = 5): RecentItem[] {
  const items = useAllItems();
  const recents = items
    .filter((item) => item.brand === brand)
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, limit);
  const recentKeys = new Set(recents.map((r) => `${r.kind}:${r.id}`));
  return items
    .filter(
      (item) =>
        item.brand === brand && !recentKeys.has(`${item.kind}:${item.id}`),
    )
    .sort(
      (a, b) =>
        b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt,
    )
    .slice(0, limit);
}
