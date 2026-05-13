#!/usr/bin/env bash
# Layer-3 smoke test against a running mcp-knowledge2 instance.
#
# Usage:
#   BASE_URL=http://localhost:8080 SERVICE_TOKEN=... JWT=... bash scripts/smoke.sh
#
# JWT must be a valid token signed by mcp-approval2 (or your mock-jwks-server
# in dev). SERVICE_TOKEN is the static internal-route bearer.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
JWT="${JWT:-}"

PASS=0; FAIL=0

check() {
  local name="$1" cmd="$2" expected="${3:-200}"
  local out status
  out=$(eval "$cmd" 2>&1) || true
  status=$(echo "$out" | tail -n 1)
  if [[ "$status" == "$expected" ]]; then
    echo "✓ $name ($status)"
    PASS=$((PASS+1))
  else
    echo "✗ $name (got $status, want $expected)"
    echo "  body: $(echo "$out" | head -n -1)"
    FAIL=$((FAIL+1))
  fi
}

# ─── Public probes ───────────────────────────────────────────────────────
check "GET /health"      "curl -s -o /dev/null -w '%{http_code}' $BASE_URL/health"
check "GET /version"     "curl -s -o /dev/null -w '%{http_code}' $BASE_URL/version"
check "GET /metrics"     "curl -s -o /dev/null -w '%{http_code}' $BASE_URL/metrics"
check "GET /v1/objects without auth" "curl -s -o /dev/null -w '%{http_code}' $BASE_URL/v1/objects" 401

# ─── With JWT (if provided) ──────────────────────────────────────────────
if [[ -n "$JWT" ]]; then
  AUTH=(-H "authorization: Bearer $JWT")
  check "GET /v1/objects with jwt" \
        "curl -s -o /dev/null -w '%{http_code}' ${AUTH[*]} $BASE_URL/v1/objects"

  # Round-trip a doc
  RES=$(curl -s -w '\n%{http_code}' "${AUTH[@]}" \
    -H 'content-type: application/json' \
    -d '{"kind":"doc","title":"smoke","body_b64":"aGVsbG8="}' \
    "$BASE_URL/v1/objects")
  STATUS=$(echo "$RES" | tail -n 1)
  if [[ "$STATUS" == "201" ]]; then
    echo "✓ POST /v1/objects ($STATUS)"
    PASS=$((PASS+1))
    OBJ_ID=$(echo "$RES" | head -n -1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
    check "GET /v1/objects/:id" \
          "curl -s -o /dev/null -w '%{http_code}' ${AUTH[*]} $BASE_URL/v1/objects/$OBJ_ID"
    check "DELETE /v1/objects/:id" \
          "curl -s -X DELETE -o /dev/null -w '%{http_code}' ${AUTH[*]} $BASE_URL/v1/objects/$OBJ_ID" 204
  else
    echo "✗ POST /v1/objects (got $STATUS)"
    echo "  body: $(echo "$RES" | head -n -1)"
    FAIL=$((FAIL+1))
  fi
else
  echo "ℹ JWT env not set — skipping authenticated tests"
fi

echo "----"
echo "passed: $PASS  failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
