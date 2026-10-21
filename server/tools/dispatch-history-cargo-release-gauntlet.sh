#!/usr/bin/env bash
set -Eeuo pipefail
cargo_release_server="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$cargo_release_server/.."
cargo_release_root="$cargo_release_server/test-artifacts/dispatch-all-history-20261002/cargo-route"
test -f "$cargo_release_server/deployments/dispatch-history-cargo-20261002/deployment-result.json"
if sudo -n docker ps --filter network=mbbs-order-history-20261002 --no-trunc --format '{{.Command}}' \
  | rg -q 'node tools/dispatch-(all-history|history-cargo)-replay.mjs'; then
  printf 'An isolated history replay is already active. Finish it before starting a fresh run.\n' >&2
  exit 1
fi
cargo_release_backup="$cargo_release_root/previous-evidence/release-$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir -p "$cargo_release_backup"
for cargo_release_folder in release-save-replays release-content-replays; do
  if [[ -d "$cargo_release_root/$cargo_release_folder" ]]; then
    mv "$cargo_release_root/$cargo_release_folder" "$cargo_release_backup/$cargo_release_folder"
  fi
  mkdir -p "$cargo_release_root/$cargo_release_folder"
done
for cargo_release_report in release-evidence.json release-source-manifest.json REPORT.md; do
  if [[ -f "$cargo_release_root/$cargo_release_report" ]]; then
    cp -a "$cargo_release_root/$cargo_release_report" "$cargo_release_backup/"
  fi
done
bash "$cargo_release_server/tools/dispatch-history-cargo-release-replay.sh" \
  > "$cargo_release_root/release-replay-pipeline.log" 2>&1
python3 "$cargo_release_server/tools/dispatch-history-cargo-release-evidence.py"
