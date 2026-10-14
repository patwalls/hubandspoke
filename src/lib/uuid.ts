const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guard for route params that go straight into a `uuid` column. Postgres
// throws "invalid input syntax for type uuid" on anything else (e.g. a
// pasted markdown link that kept its trailing `**`), which surfaces as a
// 500 + a Sentry event instead of a plain 404.
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
