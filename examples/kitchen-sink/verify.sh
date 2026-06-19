#!/usr/bin/env bash
#
# Verifies the kitchen-sink example end to end:
#   1. builds zodec + installs the example workspace
#   2. boots the Express server and exercises endpoints with curl
#   3. checks the instance and static swagger generators produce identical output
#
# Usage: bash verify.sh   (optionally PORT=4000 bash verify.sh)
set -euo pipefail

cd "$(dirname "$0")" # examples/kitchen-sink
ROOT=$(cd ../.. && pwd)
APP_DIR="$PWD/express-app"
PORT="${PORT:-3111}"
BASE="http://localhost:$PORT"
TMP="$(mktemp -d)"
fail=0

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "==> Building zodec"
npm --prefix "$ROOT" run build >/dev/null

echo "==> Installing example workspace"
npm install >/dev/null

# ----------------------------------------------------------------------------
# 1. Boot the server and exercise endpoints
# ----------------------------------------------------------------------------
echo "==> Starting server on :$PORT"
(cd "$APP_DIR" && PORT="$PORT" exec npm start) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.3
done

expect() { # expect <status> <description> <curl args...>
  local exp="$1" desc="$2"
  shift 2
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [ "$code" = "$exp" ]; then
    echo "    ✓ $desc ($code)"
  else
    echo "    ✗ $desc: expected $exp, got $code"
    fail=1
  fi
}

echo "==> Exercising endpoints"
expect 200 "GET /health" "$BASE/health"
expect 200 "GET /health/raw (@Res escape hatch)" "$BASE/health/raw"
expect 201 "POST /users (valid)" -X POST "$BASE/users" \
  -H 'content-type: application/json' \
  -d '{"username":"ada","email":"ada@example.com"}'
expect 422 "POST /users (invalid body)" -X POST "$BASE/users" \
  -H 'content-type: application/json' -d '{"username":"x"}'
expect 400 "GET /users/not-a-uuid (bad path param)" "$BASE/users/not-a-uuid"
expect 200 "GET /swagger.json" "$BASE/swagger.json"

# ----------------------------------------------------------------------------
# 2. Instance vs static swagger generators must produce identical output
# ----------------------------------------------------------------------------
echo "==> Comparing instance vs static swagger output"
npm --prefix "$APP_DIR" run --silent swagger -- "$TMP/instance.json" >/dev/null
npm --prefix "$APP_DIR" run --silent swagger:static -- "$TMP/static.json" >/dev/null

if node -e '
  const fs = require("fs");
  const sort = (v) =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      : v;
  const load = (p) => JSON.stringify(sort(JSON.parse(fs.readFileSync(p, "utf8"))));
  process.exit(load(process.argv[1]) === load(process.argv[2]) ? 0 : 1);
' "$TMP/instance.json" "$TMP/static.json"; then
  echo "    ✓ instance and static swagger match"
else
  echo "    ✗ instance and static swagger differ:"
  diff <(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])),null,2))' "$TMP/instance.json") \
       <(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])),null,2))' "$TMP/static.json") | head -40
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ kitchen-sink verification passed"
else
  echo "✗ kitchen-sink verification failed"
  echo "--- server log ---"
  tail -20 "$TMP/server.log"
fi
exit "$fail"
