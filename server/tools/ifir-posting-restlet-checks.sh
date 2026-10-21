#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
project="mbbs-ifir-response-test"
overlay="$(mktemp /tmp/mbbs-ifir-response-compose.XXXXXX.yml)"
compose=(docker compose -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans
  rm -f "$overlay"
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if docker ps -aq --filter "label=com.docker.compose.project=$project" | rg -q .; then
    echo 'Disposable IFIR test containers remain.' >&2
    return 1
  fi
  docker inspect mbbs-operator-app-app-1 --format '{{.State.Health.Status}}'
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$overlay" <<EOF
services:
  test:
    image: ${IFIR_TEST_IMAGE:-mbbs-mbt-p1-test-test:latest}
    working_dir: /app
    labels:
      com.mbbs.lifecycle: disposable-test
    volumes:
      - $server_root/src:/app/src:ro
      - $server_root/test:/app/test:ro
      - $server_root/package.json:/app/package.json:ro
      - $server_root/public:/app/public:ro
      - $server_root/artifacts/ifir-posting-restlet-20261021:/app/test-artifacts/ifir-response
      - ${IFIR_RESTLET_SOURCE:-$server_root/netsuite-ifir-posting-restlet.js}:/app/netsuite-ifir-posting-restlet.js:ro
      - $server_root/tools/ifir-posting-restlet-gauntlet.mjs:/app/tools/ifir-posting-restlet-gauntlet.mjs:ro
EOF
if [[ -n "${IFIR_TEST_NODE_MODULES:-}" ]]; then
  printf '      - %s:/app/node_modules:ro\n' "$IFIR_TEST_NODE_MODULES" >> "$overlay"
fi
if [[ $# -eq 0 ]]; then
  set -- node tools/ifir-posting-restlet-gauntlet.mjs
fi
"${compose[@]}" --profile tools run --rm --no-deps test "$@"
