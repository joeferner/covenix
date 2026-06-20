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
  # The server runs in its own process group (setsid); kill the whole group so
  # the tsx → node grandchild holding the port goes down too, not just `npm`.
  [ -n "${SERVER_PGID:-}" ] && kill -- "-$SERVER_PGID" 2>/dev/null || true
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
setsid sh -c "cd '$APP_DIR' && PORT='$PORT' exec npm start" >"$TMP/server.log" 2>&1 &
SERVER_PGID=$!

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

# @Use middleware on the controller stamps a header on every route.
if curl -s -D - -o /dev/null "$BASE/health" | grep -qi '^x-health-source: *zodec'; then
  echo "    ✓ @Use middleware sets the X-Health-Source header"
else
  echo "    ✗ @Use middleware did not set X-Health-Source"
  fail=1
fi
expect 201 "POST /users (valid)" -X POST "$BASE/users" \
  -H 'content-type: application/json' \
  -d '{"username":"ada","email":"ada@example.com"}'
expect 422 "POST /users (invalid body)" -X POST "$BASE/users" \
  -H 'content-type: application/json' -d '{"username":"x"}'
expect 400 "GET /users/not-a-uuid (bad path param)" "$BASE/users/not-a-uuid"
expect 200 "GET /swagger.json" "$BASE/swagger.json"

# serveDocs: the UI HTML at /docs references the spec at /docs/openapi.json.
expect 200 "GET /docs/openapi.json (serveDocs spec)" "$BASE/docs/openapi.json"
if curl -s "$BASE/docs" | grep -q '/docs/openapi.json'; then
  echo "    ✓ GET /docs serves UI HTML referencing the spec"
else
  echo "    ✗ GET /docs did not reference the spec"
  fail=1
fi

# @Security: /auth/me requires a bearer token.
expect 401 "GET /auth/me (no token) → 401" "$BASE/auth/me"
# Create an admin + a plain user, then mint their fake tokens (login returns one).
curl -s -X POST "$BASE/users" -H 'content-type: application/json' \
  -d '{"username":"boss","email":"boss@example.com","role":"admin"}' >/dev/null
curl -s -X POST "$BASE/users" -H 'content-type: application/json' \
  -d '{"username":"peon","email":"peon@example.com"}' >/dev/null
ADMIN_TOKEN="Bearer fake-token-for-boss"
USER_TOKEN="Bearer fake-token-for-peon"
expect 200 "GET /auth/me (valid token) → 200" "$BASE/auth/me" -H "authorization: $ADMIN_TOKEN"

# Admin-only delete: @Security('bearer', ['admin']). A user token is 403; admin is 204.
victim="$(
  curl -s -X POST "$BASE/users" -H 'content-type: application/json' \
    -d '{"username":"victim","email":"victim@example.com"}' |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).id))'
)"
expect 403 "DELETE /users/:id (non-admin) → 403" -X DELETE "$BASE/users/$victim" -H "authorization: $USER_TOKEN"
expect 204 "DELETE /users/:id (admin) → 204" -X DELETE "$BASE/users/$victim" -H "authorization: $ADMIN_TOKEN"

# @Deprecated + @OperationId surface on the legacy avatar URL operation.
if curl -s "$BASE/swagger.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const op=JSON.parse(s).paths["/users/{id}/avatar"].get;process.exit(op.deprecated===true&&op.operationId==="getUserAvatarUrl"?0:1)})'; then
  echo "    ✓ swagger marks GET /users/{id}/avatar deprecated with a custom operationId"
else
  echo "    ✗ swagger missing deprecated/operationId on /users/{id}/avatar"
  fail=1
fi

# A standalone schema (registerSchemas) appears under components.schemas even
# though no route references it.
if curl -s "$BASE/swagger.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).components?.schemas?.Notification;process.exit(c&&Array.isArray(c.oneOf)?0:1)})'; then
  echo "    ✓ swagger includes the standalone Notification schema in components"
else
  echo "    ✗ swagger missing standalone Notification schema"
  fail=1
fi

# Swagger advertises the bearer scheme + the per-operation requirement.
if curl -s "$BASE/swagger.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const ok=d.components?.securitySchemes?.bearer?.scheme==="bearer" && Array.isArray(d.paths["/auth/me"].get.security);process.exit(ok?0:1)})'; then
  echo "    ✓ swagger documents the bearer scheme + /auth/me security"
else
  echo "    ✗ swagger missing security scheme/requirement"
  fail=1
fi

# Response header declared via @Returns(..., { headers }) and set by the handler.
if curl -s -D - -o /dev/null "$BASE/users" | grep -qi '^x-total-count:'; then
  echo "    ✓ GET /users sets the X-Total-Count response header"
else
  echo "    ✗ GET /users missing X-Total-Count header"
  fail=1
fi

# File download: create a user, then download it as CSV (@ReturnsFile / FileResponse).
uid="$(
  curl -s -X POST "$BASE/users" -H 'content-type: application/json' \
    -d '{"username":"bob","email":"bob@example.com"}' |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).id))'
)"
DL_HEADERS="$TMP/export.headers"
DL_BODY="$(curl -s -D "$DL_HEADERS" "$BASE/users/$uid/export")"
DL_CODE="$(awk 'NR==1{print $2}' "$DL_HEADERS")"
if [ "$DL_CODE" = "200" ] &&
  grep -qi '^content-type: *text/csv' "$DL_HEADERS" &&
  grep -qi '^content-disposition: *attachment' "$DL_HEADERS" &&
  printf '%s' "$DL_BODY" | head -1 | grep -q '^id,username,email'; then
  echo "    ✓ GET /users/:id/export streams CSV (200, content-type + attachment)"
else
  echo "    ✗ GET /users/:id/export failed (code=$DL_CODE)"
  sed -n '1,8p' "$DL_HEADERS"
  fail=1
fi

# Multipart upload (@Body with a z.file() field → multipart/form-data).
PNG="$TMP/avatar.png"
printf '\211PNG\r\n\032\n' >"$PNG" # minimal PNG signature; enough bytes to upload
UP_BODY="$(curl -s -X POST "$BASE/users/$uid/avatar" \
  -F "avatar=@$PNG;type=image/png" -F 'caption=hi there')"
if printf '%s' "$UP_BODY" | grep -q '"contentType":"image/png"' &&
  printf '%s' "$UP_BODY" | grep -q '"caption":"hi there"'; then
  echo "    ✓ POST /users/:id/avatar accepts a multipart upload"
else
  echo "    ✗ POST /users/:id/avatar upload failed: $UP_BODY"
  fail=1
fi

# A non-image upload must be rejected by the schema's .mime() constraint (422).
expect 422 "POST /users/:id/avatar (wrong mime type) → 422" \
  -X POST "$BASE/users/$uid/avatar" -F "avatar=@$PNG;type=image/gif"

# Download the uploaded avatar with an HTTP Range (RangeFileResponse, inline).
RAW_HEADERS="$TMP/avatar.headers"
curl -s -D "$RAW_HEADERS" -o /dev/null -H 'Range: bytes=0-2' "$BASE/users/$uid/avatar/raw"
RAW_CODE="$(awk 'NR==1{print $2}' "$RAW_HEADERS")"
if [ "$RAW_CODE" = "206" ] &&
  grep -qi '^accept-ranges: *bytes' "$RAW_HEADERS" &&
  grep -qi '^content-range: *bytes 0-2/' "$RAW_HEADERS" &&
  grep -qi '^content-disposition: *inline' "$RAW_HEADERS"; then
  echo "    ✓ GET /users/:id/avatar/raw serves a 206 partial range (inline)"
else
  echo "    ✗ GET /users/:id/avatar/raw range failed (code=$RAW_CODE)"
  sed -n '1,10p' "$RAW_HEADERS"
  fail=1
fi

# Swagger advertises the upload as a binary multipart body.
if curl -s "$BASE/swagger.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const b=d.paths["/users/{id}/avatar"].post.requestBody.content["multipart/form-data"].schema.properties.avatar;process.exit(b.format==="binary"?0:1)})'; then
  echo "    ✓ swagger documents /users/{id}/avatar as a binary multipart body"
else
  echo "    ✗ swagger missing binary multipart body for /users/{id}/avatar"
  fail=1
fi

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
