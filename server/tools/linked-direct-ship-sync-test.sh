#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_project="mbbs-direct-ship-sync-$$"
artifact="$repo_root/server/test-artifacts/linked-direct-ship-sync"
source_root="${DIRECT_SHIP_SYNC_SOURCE_ROOT:-$repo_root/server}"
test_image="${DIRECT_SHIP_SYNC_TEST_IMAGE:-mbbs-to-yard-test-browser:20261009}"
mkdir -p "$artifact"
override="$artifact/compose-$$.yml"
compose=(docker compose -p "$test_project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans > "$artifact/cleanup-$test_project.log" 2>&1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/running-after-$test_project.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/all-after-$test_project.log"
  if rg -q "$test_project" "$artifact/all-after-$test_project.log"; then return 1; fi
}
trap cleanup EXIT
cat > "$override" <<YAML
services:
  test:
    image: $test_image
    working_dir: /app
    cpus: "1.0"
    user: "1000:1000"
    entrypoint: []
    labels:
      com.mbbs.lifecycle: disposable-test
    volumes:
      - $repo_root/server/test-artifacts/driver-upload-reliability/toolchain/node_modules:/app/node_modules:ro
      - $repo_root/server/test:/app/test:ro
      - $repo_root/server/tools:/app/tools:ro
      - $repo_root/server/migrations:/app/migrations:ro
      - $repo_root/server/public:/app/public:ro
      - $repo_root/server/contracts:/app/contracts:ro
      - $repo_root/server/.env.example:/app/.env.example:ro
      - $repo_root/server/Dockerfile:/app/Dockerfile:ro
      - $repo_root/server/Dockerfile.test:/app/Dockerfile.test:ro
      - $repo_root/server/package.json:/app/package.json:ro
      - $repo_root/server/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro
      - $repo_root/server/tsconfig.mbt.json:/app/tsconfig.mbt.json:ro
YAML
if [[ "${DIRECT_SHIP_SYNC_USE_IMAGE_SOURCE:-0}" != 1 ]]; then
  printf '      - %s/src:/app/src:ro\n' "$source_root" >> "$override"
fi
for source_file in "$repo_root/server/"*.js; do
  printf '      - %s:/app/%s:ro\n' "$source_file" "$(basename "$source_file")" >> "$override"
done
"${compose[@]}" up -d --wait db > "$artifact/db-$test_project.log" 2>&1
"${compose[@]}" --profile tools run --rm --no-deps test npm run migrate > "$artifact/migrate-$test_project.log" 2>&1
"${compose[@]}" --profile tools run --rm --no-deps test "$@"
