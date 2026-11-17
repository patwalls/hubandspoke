/**
 * Display helpers for the admin AI-spend page (/settings/ai-spend). Pure so
 * the rounding rules are unit-tested: a feature that cost $0.003 must not
 * read as "$0.00" (looks free) and a big month must not show cents noise.
 */

/** `$1,234`, `$12.34`, `$0.42`, `<$0.01`, `$0`. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

/** `950`, `12.3K`, `4.5M`, `1.2B` — token counts span nine orders of magnitude. */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(n);
}

/** What a feature used, for the table's usage column: tokens, or audio minutes for speech-to-text. */
export function formatUsage(f: { inputTokens: number; outputTokens: number; audioSeconds: number }): string {
  const parts: string[] = [];
  if (f.inputTokens || f.outputTokens) {
    parts.push(`${formatCount(f.inputTokens)} in · ${formatCount(f.outputTokens)} out`);
  }
  if (f.audioSeconds) parts.push(`${formatCount(Math.round(f.audioSeconds / 60))} audio min`);
  return parts.join(" · ") || "—";
}

/** `anthropic` → `Claude`, `openai` → `OpenAI`; anything else as stored. */
export function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai") return "OpenAI";
  return provider;
}
