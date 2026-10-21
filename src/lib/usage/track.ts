"use client";

/**
 * Record a non-route usage mark (`modal:clip-editor`, `whats-new:click:<id>`)
 * from a client component. Fire-and-forget: never awaits, never throws, never
 * blocks the click it rides on. Route views are recorded by UsageTracker.
 */
export function trackUsage(mark: string, brand?: string | null): void {
  try {
    void fetch("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark, brand: brand ?? undefined }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // usage is best-effort
  }
}
