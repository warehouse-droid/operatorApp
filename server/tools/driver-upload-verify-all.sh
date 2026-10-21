#!/usr/bin/env bash
set -euo pipefail
driver_upload_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$driver_upload_root"
driver_upload_artifacts=server/test-artifacts/driver-upload-reliability
driver_upload_mode=${1:-all}
mkdir -p "$driver_upload_artifacts"
if [[ "$driver_upload_mode" != --finalize ]]; then
  if [[ ! -f "$driver_upload_artifacts/toolchain/node_modules/@playwright/test/package.json" ]]; then
    bash server/tools/driver-upload-unit-check.sh install
  fi
  for driver_upload_phase in quality-focused coverage mutations secrets; do
    bash server/tools/driver-upload-unit-check.sh "$driver_upload_phase"
  done
  for driver_upload_phase in repository-types baseline-types; do
    driver_upload_status=0
    bash server/tools/driver-upload-unit-check.sh "$driver_upload_phase" > "$driver_upload_artifacts/$driver_upload_phase-command.log" 2>&1 || driver_upload_status=$?
    printf '%s\n' "$driver_upload_status" > "$driver_upload_artifacts/$driver_upload_phase-exit-code.txt"
  done
  for driver_upload_phase in regressions-baseline regressions; do
    driver_upload_status=0
    bash server/tools/driver-upload-gauntlet.sh "$driver_upload_phase" > "$driver_upload_artifacts/$driver_upload_phase-command.log" 2>&1 || driver_upload_status=$?
    printf '%s\n' "$driver_upload_status" > "$driver_upload_artifacts/$driver_upload_phase-exit-code.txt"
  done
  bash server/tools/driver-upload-gauntlet.sh backend
fi
if [[ "$driver_upload_mode" == --checks-only ]]; then exit; fi
if [[ "$driver_upload_mode" != --finalize ]]; then bash server/tools/driver-upload-gauntlet.sh final; fi
docker ps --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/final-docker-ps.txt"
docker ps -a --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/final-docker-ps-a.txt"
if rg '^mbbs-driver-upload-' "$driver_upload_artifacts/final-docker-ps.txt" "$driver_upload_artifacts/final-docker-ps-a.txt"; then
  printf '%s\n' 'Upload test containers remain; final verification refused.' >&2
  exit 1
fi
docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$driver_upload_artifacts/final-production-health.txt"
python3 server/tools/driver-upload-evidence.py
