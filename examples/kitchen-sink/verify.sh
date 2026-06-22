#!/usr/bin/env bash
#
# Verifies the kitchen-sink example end to end:
#   1. builds avero + installs the example workspace
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

echo "==> Building avero"
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
  curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break
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
expect 200 "GET /v1/health" "$BASE/v1/health"
expect 200 "GET /v1/health/raw (@Res escape hatch)" "$BASE/v1/health/raw"

# @Sse streams text/event-stream; the finite stream completes so curl returns.
SSE_HEADERS="$TMP/sse.headers"
SSE_BODY="$(curl -s -N -D "$SSE_HEADERS" "$BASE/v1/health/events")"
if grep -qi '^content-type: *text/event-stream' "$SSE_HEADERS" &&
  printf '%s' "$SSE_BODY" | grep -q '^data: {"status":"ok"'; then
  echo "    ✓ GET /v1/health/events streams Server-Sent Events"
else
  echo "    ✗ GET /v1/health/events SSE stream failed"
  sed -n '1,6p' "$SSE_HEADERS"
  fail=1
fi

# @Use middleware on the controller stamps a header on every route.
if curl -s -D - -o /dev/null "$BASE/v1/health" | grep -qi '^x-health-source: *avero'; then
  echo "    ✓ @Use middleware sets the X-Health-Source header"
else
  echo "    ✗ @Use middleware did not set X-Health-Source"
  fail=1
fi

# createParamDecorator (ClientIp) injects req.ip; the handler echoes it back as an
# undeclared header via HttpResponse.
if curl -s -D - -o /dev/null "$BASE/v1/health" | grep -qi '^x-client-ip:'; then
  echo "    ✓ createParamDecorator injects the client IP (X-Client-IP header)"
else
  echo "    ✗ createParamDecorator value did not reach X-Client-IP"
  fail=1
fi
expect 201 "POST /v1/users (valid)" -X POST "$BASE/v1/users" \
  -H 'content-type: application/json' \
  -d '{"username":"ada","email":"ada@example.com"}'
expect 422 "POST /v1/users (invalid body)" -X POST "$BASE/v1/users" \
  -H 'content-type: application/json' -d '{"username":"x"}'
expect 400 "GET /v1/users/not-a-uuid (bad path param)" "$BASE/v1/users/not-a-uuid"

# serveDocs: the UI HTML at /docs references the spec at /docs/openapi.json.
expect 200 "GET /docs/openapi.json (serveDocs spec)" "$BASE/docs/openapi.json"
if curl -s "$BASE/docs" | grep -q '/docs/openapi.json'; then
  echo "    ✓ GET /docs serves UI HTML referencing the spec"
else
  echo "    ✗ GET /docs did not reference the spec"
  fail=1
fi

# @Security: /v1/auth/me requires a bearer token.
expect 401 "GET /v1/auth/me (no token) → 401" "$BASE/v1/auth/me"
# Create an admin + a plain user, then mint their fake tokens (login returns one).
curl -s -X POST "$BASE/v1/users" -H 'content-type: application/json' \
  -d '{"username":"boss","email":"boss@example.com","role":"admin"}' >/dev/null
curl -s -X POST "$BASE/v1/users" -H 'content-type: application/json' \
  -d '{"username":"peon","email":"peon@example.com"}' >/dev/null
ADMIN_TOKEN="Bearer fake-token-for-boss"
USER_TOKEN="Bearer fake-token-for-peon"
expect 200 "GET /v1/auth/me (valid token) → 200" "$BASE/v1/auth/me" -H "authorization: $ADMIN_TOKEN"

# Admin-only delete: @Security('bearer', ['admin']). A user token is 403; admin is 204.
victim="$(
  curl -s -X POST "$BASE/v1/users" -H 'content-type: application/json' \
    -d '{"username":"victim","email":"victim@example.com"}' |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).id))'
)"
expect 403 "DELETE /v1/users/:id (non-admin) → 403" -X DELETE "$BASE/v1/users/$victim" -H "authorization: $USER_TOKEN"
expect 204 "DELETE /v1/users/:id (admin) → 204" -X DELETE "$BASE/v1/users/$victim" -H "authorization: $ADMIN_TOKEN"

# @Deprecated + @OperationId surface on the legacy avatar URL operation.
if curl -s "$BASE/docs/openapi.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const op=JSON.parse(s).paths["/v1/users/{id}/avatar"].get;process.exit(op.deprecated===true&&op.operationId==="getUserAvatarUrl"?0:1)})'; then
  echo "    ✓ swagger marks GET /v1/users/{id}/avatar deprecated with a custom operationId"
else
  echo "    ✗ swagger missing deprecated/operationId on /v1/users/{id}/avatar"
  fail=1
fi

# A standalone schema (registerSchemas) appears under components.schemas even
# though no route references it — and a named z.discriminatedUnion emits oneOf +
# a discriminator with a $ref mapping.
if curl -s "$BASE/docs/openapi.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).components?.schemas?.Notification;const ok=c&&Array.isArray(c.oneOf)&&c.discriminator?.propertyName==="type"&&c.discriminator?.mapping?.message==="#/components/schemas/MessageNotification";process.exit(ok?0:1)})'; then
  echo "    ✓ swagger emits the Notification union with oneOf + discriminator mapping"
else
  echo "    ✗ swagger missing Notification discriminator/mapping"
  fail=1
fi

# Swagger advertises the bearer scheme + the per-operation requirement.
if curl -s "$BASE/docs/openapi.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const ok=d.components?.securitySchemes?.bearer?.scheme==="bearer" && Array.isArray(d.paths["/v1/auth/me"].get.security);process.exit(ok?0:1)})'; then
  echo "    ✓ swagger documents the bearer scheme + /v1/auth/me security"
else
  echo "    ✗ swagger missing security scheme/requirement"
  fail=1
fi

# Response header declared via @Returns(..., { headers }) and set by the handler.
if curl -s -D - -o /dev/null "$BASE/v1/users" | grep -qi '^x-total-count:'; then
  echo "    ✓ GET /v1/users sets the X-Total-Count response header"
else
  echo "    ✗ GET /v1/users missing X-Total-Count header"
  fail=1
fi

# File download: create a user, then download it as CSV (@ReturnsFile / FileResponse).
uid="$(
  curl -s -X POST "$BASE/v1/users" -H 'content-type: application/json' \
    -d '{"username":"bob","email":"bob@example.com"}' |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).id))'
)"
DL_HEADERS="$TMP/export.headers"
DL_BODY="$(curl -s -D "$DL_HEADERS" "$BASE/v1/users/$uid/export")"
DL_CODE="$(awk 'NR==1{print $2}' "$DL_HEADERS")"
if [ "$DL_CODE" = "200" ] &&
  grep -qi '^content-type: *text/csv' "$DL_HEADERS" &&
  grep -qi '^content-disposition: *attachment' "$DL_HEADERS" &&
  printf '%s' "$DL_BODY" | head -1 | grep -q '^id,username,email'; then
  echo "    ✓ GET /v1/users/:id/export streams CSV (200, content-type + attachment)"
else
  echo "    ✗ GET /v1/users/:id/export failed (code=$DL_CODE)"
  sed -n '1,8p' "$DL_HEADERS"
  fail=1
fi

# Multipart upload (@Body with a z.file() field → multipart/form-data).
PNG="$TMP/avatar.png"
printf '\211PNG\r\n\032\n' >"$PNG" # minimal PNG signature; enough bytes to upload
UP_BODY="$(curl -s -X POST "$BASE/v1/users/$uid/avatar" \
  -F "avatar=@$PNG;type=image/png" -F 'caption=hi there')"
if printf '%s' "$UP_BODY" | grep -q '"contentType":"image/png"' &&
  printf '%s' "$UP_BODY" | grep -q '"caption":"hi there"'; then
  echo "    ✓ POST /v1/users/:id/avatar accepts a multipart upload"
else
  echo "    ✗ POST /v1/users/:id/avatar upload failed: $UP_BODY"
  fail=1
fi

# A non-image upload must be rejected by the schema's .mime() constraint (422).
expect 422 "POST /v1/users/:id/avatar (wrong mime type) → 422" \
  -X POST "$BASE/v1/users/$uid/avatar" -F "avatar=@$PNG;type=image/gif"

# Download the uploaded avatar with an HTTP Range (RangeFileResponse, inline).
RAW_HEADERS="$TMP/avatar.headers"
curl -s -D "$RAW_HEADERS" -o /dev/null -H 'Range: bytes=0-2' "$BASE/v1/users/$uid/avatar/raw"
RAW_CODE="$(awk 'NR==1{print $2}' "$RAW_HEADERS")"
if [ "$RAW_CODE" = "206" ] &&
  grep -qi '^accept-ranges: *bytes' "$RAW_HEADERS" &&
  grep -qi '^content-range: *bytes 0-2/' "$RAW_HEADERS" &&
  grep -qi '^content-disposition: *inline' "$RAW_HEADERS"; then
  echo "    ✓ GET /v1/users/:id/avatar/raw serves a 206 partial range (inline)"
else
  echo "    ✗ GET /v1/users/:id/avatar/raw range failed (code=$RAW_CODE)"
  sed -n '1,10p' "$RAW_HEADERS"
  fail=1
fi

# Swagger advertises the upload as a binary multipart body.
if curl -s "$BASE/docs/openapi.json" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const b=d.paths["/v1/users/{id}/avatar"].post.requestBody.content["multipart/form-data"].schema.properties.avatar;process.exit(b.format==="binary"?0:1)})'; then
  echo "    ✓ swagger documents /v1/users/{id}/avatar as a binary multipart body"
else
  echo "    ✗ swagger missing binary multipart body for /v1/users/{id}/avatar"
  fail=1
fi

# ----------------------------------------------------------------------------
# 2. Generated artifacts: instance ≡ static, and both match the committed
#    snapshots in __snapshots__/. Run `UPDATE_SNAPSHOTS=1 bash verify.sh` to
#    regenerate the snapshots after an intentional change.
# ----------------------------------------------------------------------------
echo "==> Validating generated artifacts against snapshots"
SNAP="$PWD/__snapshots__"

# Deep, key-order-insensitive JSON equality (exit 0 if equal).
json_eq() {
  node -e '
    const fs = require("fs");
    const sort = (v) =>
      Array.isArray(v) ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
        : v;
    const load = (p) => JSON.stringify(sort(JSON.parse(fs.readFileSync(p, "utf8"))));
    process.exit(load(process.argv[1]) === load(process.argv[2]) ? 0 : 1);
  ' "$1" "$2"
}

# artifact <name> <instance-script> <static-script>
# Generates the instance + static outputs, then either updates the snapshot
# (UPDATE_SNAPSHOTS=1) or checks instance≡static and instance≡snapshot.
artifact() {
  local name="$1" inst="$2" stat="$3" snap="$SNAP/$1.json"
  npm --prefix "$APP_DIR" run --silent "$inst" -- "$TMP/$name-instance.json" >/dev/null
  npm --prefix "$APP_DIR" run --silent "$stat" -- "$TMP/$name-static.json" >/dev/null

  if [ "${UPDATE_SNAPSHOTS:-}" = "1" ]; then
    cp "$TMP/$name-instance.json" "$snap"
    echo "    ↻ updated snapshot $name.json"
    return
  fi

  if json_eq "$TMP/$name-instance.json" "$TMP/$name-static.json"; then
    echo "    ✓ $name: instance and static generators match"
  else
    echo "    ✗ $name: instance and static generators differ"
    fail=1
  fi
  if [ -f "$snap" ] && json_eq "$TMP/$name-instance.json" "$snap"; then
    echo "    ✓ $name: output matches __snapshots__/$name.json"
  else
    echo "    ✗ $name: output differs from __snapshots__/$name.json (run UPDATE_SNAPSHOTS=1 bash verify.sh)"
    fail=1
  fi
}

artifact swagger swagger swagger:static
artifact contract contract contract:static

# The generated TypeScript client: text-identical to its snapshot, type-checks
# standalone under strict mode (the classic codegen failure to catch), and
# actually works when pointed at the running server (verify-client.ts).
GEN_CLIENT="$APP_DIR/src/api.gen.ts"
npm --prefix "$APP_DIR" run --silent client -- "$GEN_CLIENT" >/dev/null
if [ "${UPDATE_SNAPSHOTS:-}" = "1" ]; then
  cp "$GEN_CLIENT" "$SNAP/api.gen.ts"
  echo "    ↻ updated snapshot api.gen.ts"
else
  if diff -q "$SNAP/api.gen.ts" "$GEN_CLIENT" >/dev/null; then
    echo "    ✓ client: output matches __snapshots__/api.gen.ts"
  else
    echo "    ✗ client: output differs from __snapshots__/api.gen.ts (run UPDATE_SNAPSHOTS=1 bash verify.sh)"
    fail=1
  fi
  if node "$ROOT/node_modules/typescript/bin/tsc" --noEmit --ignoreConfig --strict \
    --target es2022 --module nodenext --moduleResolution nodenext --lib es2022,dom \
    "$GEN_CLIENT" 2>"$TMP/client-tsc.log"; then
    echo "    ✓ client: type-checks standalone under strict mode"
  else
    echo "    ✗ client: generated client has type errors"
    sed -n '1,20p' "$TMP/client-tsc.log"
    fail=1
  fi
  # Run the generated client against the live server.
  if npm --prefix "$APP_DIR" run --silent verify:client -- "$BASE" >"$TMP/client-run.log" 2>&1; then
    sed 's/^/    /' "$TMP/client-run.log"
  else
    echo "    ✗ client: exercising the generated client against the server failed"
    sed -n '1,30p' "$TMP/client-run.log"
    fail=1
  fi
fi
rm -f "$GEN_CLIENT" # generated artifact — not committed (see .gitignore)

# The validating client variant (`--validate`): imports zod, parses requests and
# responses against regenerated schemas. Same checks as the base client plus a
# live exercise that proves real server responses conform to the contract.
VGEN_CLIENT="$APP_DIR/src/api.validated.gen.ts"
npm --prefix "$APP_DIR" run --silent client -- "$VGEN_CLIENT" --validate >/dev/null
if [ "${UPDATE_SNAPSHOTS:-}" = "1" ]; then
  cp "$VGEN_CLIENT" "$SNAP/api.validated.gen.ts"
  echo "    ↻ updated snapshot api.validated.gen.ts"
else
  if diff -q "$SNAP/api.validated.gen.ts" "$VGEN_CLIENT" >/dev/null; then
    echo "    ✓ validating client: output matches __snapshots__/api.validated.gen.ts"
  else
    echo "    ✗ validating client: output differs (run UPDATE_SNAPSHOTS=1 bash verify.sh)"
    fail=1
  fi
  if node "$ROOT/node_modules/typescript/bin/tsc" --noEmit --ignoreConfig --strict \
    --target es2022 --module nodenext --moduleResolution nodenext --lib es2022,dom \
    "$VGEN_CLIENT" 2>"$TMP/vclient-tsc.log"; then
    echo "    ✓ validating client: type-checks standalone (with its zod import)"
  else
    echo "    ✗ validating client: generated client has type errors"
    sed -n '1,20p' "$TMP/vclient-tsc.log"
    fail=1
  fi
  if npm --prefix "$APP_DIR" run --silent verify:client:validated -- "$BASE" >"$TMP/vclient-run.log" 2>&1; then
    sed 's/^/    /' "$TMP/vclient-run.log"
  else
    echo "    ✗ validating client: exercising it against the server failed"
    sed -n '1,30p' "$TMP/vclient-run.log"
    fail=1
  fi
fi
rm -f "$VGEN_CLIENT" # generated artifact — not committed (see .gitignore)

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ kitchen-sink verification passed"
else
  echo "✗ kitchen-sink verification failed"
  echo "--- server log ---"
  tail -20 "$TMP/server.log"
fi
exit "$fail"
