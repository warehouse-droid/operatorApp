#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo/server/test-artifacts/operator-to-yard-flow"
name="mbbs-to-yard-browser-dependencies-$$"
image="mbbs-to-yard-test-browser:20261009"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  sudo -n docker rm -f "$name" >/dev/null 2>&1 || true
  sudo -n docker ps --format '{{.Names}} {{.Status}}' > "$artifact/browser-image-running.log"
  sudo -n docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/browser-image-all.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n docker run --rm -d --name "$name" --init --cgroup-parent=mbbs-tests.slice \
  --label com.mbbs.lifecycle=disposable-test --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --tmpfs /tmp:rw,size=512m -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  --mount "type=bind,src=$repo/server/test-artifacts/operator-to-yard-flow-tooling,dst=/deps,readonly" \
  node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
  bash -c 'node /deps/node_modules/playwright/cli.js install --with-deps chromium webkit && touch /browser-ready && exec sleep 600' >/dev/null
for attempt in {1..240}; do
  if sudo -n docker exec "$name" test -f /browser-ready; then
    sudo -n docker logs "$name" > "$artifact/browser-dependencies.log" 2>&1
    sudo -n docker commit --change 'ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright' "$name" "$image" > "$artifact/browser-image-id.txt"
    exit 0
  fi
  if [[ "$(sudo -n docker inspect "$name" --format '{{.State.Running}}')" != true ]]; then
    sudo -n docker logs "$name" > "$artifact/browser-dependencies.log" 2>&1 || true
    exit 1
  fi
  sleep 1
done
sudo -n docker logs "$name" > "$artifact/browser-dependencies.log" 2>&1
exit 1
