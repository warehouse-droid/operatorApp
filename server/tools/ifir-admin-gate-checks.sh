#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$server_root/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_root/docker/retention/retention.py" run --root /tmp/mbbs-ifir-test-artifacts -- bash "$0" "$@"
fi
audit_root="$server_root/test-artifacts/ifir-admin-gate-20261021"
mkdir -p "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate" "$audit_root"
project="mbbs-ifir-admin-gate-test"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.ifir.yml"
compose=(docker compose -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans
  sudo -n chown -R "$(id -u):$(id -g)" "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate"
  # The user requested retention of logs and evidence, never test databases.
  cp -R "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate/." "$audit_root/"
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if docker ps -aq --filter "label=com.docker.compose.project=$project" | rg -q .; then return 1; fi
  docker inspect mbbs-operator-app-app-1 --format '{{.State.Health.Status}}'
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$overlay" <<EOF
services:
  test:
    image: ${IFIR_ADMIN_GATE_IMAGE:-mbbs-operator-app:dispatch-editor-control-browser-test-20261015}
    working_dir: /app
    labels:
      com.mbbs.lifecycle: disposable-test
    volumes:
      - ${IFIR_ADMIN_GATE_SOURCE_ROOT:-$server_root/src}:/app/src:ro
      - $server_root/test:/app/test:ro
      - ${IFIR_ADMIN_GATE_RUNTIME_ROOT:-$server_root}/public:/app/public:ro
      - ${IFIR_ADMIN_GATE_RUNTIME_ROOT:-$server_root}/migrations:/app/migrations:ro
      - ${IFIR_ADMIN_GATE_RUNTIME_ROOT:-$server_root}/contracts:/app/contracts:ro
      - $server_root/package.json:/app/package.json:ro
      - $server_root/.env.example:/app/.env.example:ro
      - $server_root/netsuite-ifir-posting-restlet.js:/app/netsuite-ifir-posting-restlet.js:ro
      - ${IFIR_ADMIN_GATE_BASELINE_ROOT:-$server_root/artifacts/ifir-admin-gate-20261021/before}:/app/gate-before:ro
      - $MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate:/app/test-artifacts/ifir-admin-gate
      - $server_root/tools/ifir-admin-gate-gauntlet.mjs:/app/tools/ifir-admin-gate-gauntlet.mjs:ro
      - $server_root/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro
EOF
if [[ $# -eq 0 ]]; then set -- node tools/ifir-admin-gate-gauntlet.mjs; fi
"${compose[@]}" --profile tools up -d --wait db
"${compose[@]}" --profile tools run --rm --no-deps test sh -c 'umask 0002; exec "$@"' sh "$@"
if [[ -f "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate/final/report.json" ]]; then
  sudo -n chown -R "$(id -u):$(id -g)" "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate"
  python3 "$server_root/tools/ifir-admin-gate-coverage.py" "$MBBS_TEST_ARTIFACT_DIR/ifir-admin-gate/final"
fi
