#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/compose.yml"
PROJECT="derpibooru-poster-test-$$"

cleanup() {
  docker compose -p "$PROJECT" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[integration] Booting ephemeral mongo (project=$PROJECT)..."
docker compose -p "$PROJECT" -f "$COMPOSE" up -d

echo "[integration] Waiting for mongo readiness on :27019 ..."
for i in $(seq 1 60); do
  if docker compose -p "$PROJECT" -f "$COMPOSE" exec -T mongo mongosh --quiet --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then
    echo "[integration] mongo is up"
    break
  fi
  sleep 1
done

cd "$HERE/../.."
export INT_MONGO_HOST=127.0.0.1
export INT_MONGO_PORT=27019
export INT_MONGO_USER=testuser
export INT_MONGO_PASSWORD=testpass

node --experimental-strip-types --no-warnings=ExperimentalWarning \
  --experimental-test-coverage \
  --test-coverage-exclude='test/**' \
  --test-coverage-exclude='node_modules/**' \
  --test test/integration/*.test.ts
