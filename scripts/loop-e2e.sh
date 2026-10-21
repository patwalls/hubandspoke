#!/bin/bash
# Run ONE Playwright e2e spec against this tree on a throwaway database — the product loop's
# visual check (`/build`). Its laps run on the Hetzner box, which has no Postgres and no browser
# that can log in here, so the ship broker runs this on the MacBook Pro in a worktree of the
# lap's branch:
#
#   ship run hubandspoke e2e --branch app-loop/<slug> -- <spec>.spec.ts [/tmp/hs-build/<name>.png]
#
# The spec reads E2E_SHOT (the png path, if given) and screenshots there; the broker copies that
# file back to the lap. On a failure with no shot, Playwright's own failure screenshot is copied
# to it instead, so the lap can always look.
#
# Isolation: a fresh Postgres cluster in a temp dir (trust auth, TCP on 127.0.0.1 only, no
# socket, removed on exit) built from schema.ts with drizzle-kit push; one seeded login
# (e2e@local.test) and one brand. The dev server gets a minimal env — no .env.local, no prod
# credentials — so a page that needs S3 / an LLM / Notion shows its empty or error state.
set -euo pipefail

SPEC="${1:?usage: loop-e2e.sh <spec>.spec.ts [/tmp/hs-build/<name>.png]}"
SHOT="${2:-}"
[[ "$SPEC" =~ ^[a-z0-9-]+\.spec\.ts$ ]] || { echo "spec must be a file name in tests/e2e, e.g. whats-new.spec.ts"; exit 2; }
[[ -f "tests/e2e/$SPEC" ]] || { echo "no tests/e2e/$SPEC on this branch"; exit 2; }
if [[ -n "$SHOT" ]]; then
  [[ "$SHOT" =~ ^/tmp/hs-build/[A-Za-z0-9._-]+\.png$ ]] || { echo "shot must be /tmp/hs-build/<name>.png"; exit 2; }
  mkdir -p /tmp/hs-build && rm -f "$SHOT"
fi

ROOT="$(pwd)"
PGBIN=/Applications/Postgres.app/Contents/Versions/18/bin
WORK="$(mktemp -d /tmp/hse2e.XXXXXX)"

free_port() { local p=$1; while lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done; echo "$p"; }
PGPORT=$(free_port 55400)
WEBPORT=$(free_port 3400)

DEV_PID=""
cleanup() {
  [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null || true
  # npx's child (the real next server) outlives its parent: stop whatever holds our port.
  lsof -tiTCP:"$WEBPORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  "$PGBIN/pg_ctl" -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Dependencies: reinstall only when the lockfile changed since the last run in this worktree.
LOCK_SUM=$(shasum -a 256 package-lock.json | cut -c1-16)
if [[ ! -d node_modules || "$(cat node_modules/.lock-sum 2>/dev/null)" != "$LOCK_SUM" ]]; then
  echo "== npm ci"
  npm ci --no-audit --no-fund --loglevel=error >/dev/null
  echo "$LOCK_SUM" > node_modules/.lock-sum
fi

echo "== postgres :$PGPORT"
"$PGBIN/initdb" -D "$WORK/pg" -U e2e --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/pg" -o "-p $PGPORT -k '' -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" -w start >/dev/null
"$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U e2e hs

# The minimal env every step below shares: nothing from this Mac's shell beyond PATH/HOME.
BASE_ENV=(
  "PATH=$PATH" "HOME=$HOME"
  "DATABASE_URL=postgresql://e2e@127.0.0.1:$PGPORT/hs" "DATABASE_SSL=off"
  "AUTH_SECRET=loop-e2e-$(openssl rand -hex 16)" "AUTH_TRUST_HOST=true"
  "NEXTAUTH_URL=http://localhost:$WEBPORT"
  "E2E_TEST_USER_EMAIL=e2e@local.test" "E2E_TEST_USER_PASSWORD=change-me-locally"
)
run_env() { env -i "${BASE_ENV[@]}" "$@"; }

echo "== schema"
run_env npx drizzle-kit push --force >/dev/null
run_env node scripts/graphile-migrate.mjs >/dev/null
run_env node scripts/seed-user.mjs e2e@local.test change-me-locally 'E2E Test' >/dev/null
"$PGBIN/psql" -q -h 127.0.0.1 -p "$PGPORT" -U e2e hs \
  -c "UPDATE users SET role = 'admin'; INSERT INTO brands (slug, label) VALUES ('starter-story', 'Starter Story') ON CONFLICT DO NOTHING;"

echo "== next dev :$WEBPORT"
run_env "NEXT_TELEMETRY_DISABLED=1" npx next dev -p "$WEBPORT" > "$WORK/dev.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 90); do
  curl -s -o /dev/null "http://localhost:$WEBPORT/login" && break
  sleep 2
done
curl -s -o /dev/null "http://localhost:$WEBPORT/login" || { echo "dev server never answered"; tail -40 "$WORK/dev.log"; exit 1; }

cat > "$WORK/pw.config.ts" <<EOF
import base from "$ROOT/playwright.config";
export default {
  ...base,
  testDir: "$ROOT/tests/e2e",
  outputDir: "$WORK/results",
  webServer: undefined,
  workers: 1,
  use: { ...base.use, baseURL: "http://localhost:$WEBPORT", channel: "chrome" },
  projects: base.projects?.map((p) => ({ ...p, use: { ...p.use, channel: "chrome" } })),
};
EOF

echo "== playwright $SPEC"
set +e
run_env "E2E_SHOT=$SHOT" npx playwright test -c "$WORK/pw.config.ts" "$SPEC" --reporter=line 2>&1 | tail -60
RC=${PIPESTATUS[0]}
set -e

if [[ -n "$SHOT" && ! -f "$SHOT" ]]; then
  FAIL_SHOT=$(find "$WORK/results" -name '*.png' 2>/dev/null | head -1)
  [[ -n "$FAIL_SHOT" ]] && cp "$FAIL_SHOT" "$SHOT" && echo "(no shot from the spec; copied Playwright's failure screenshot)"
fi
if [[ $RC -ne 0 ]]; then
  echo "== dev server log (tail)"
  grep -E "Error|error|⨯" "$WORK/dev.log" | tail -20
fi
exit "$RC"
