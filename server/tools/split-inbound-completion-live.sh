#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:-read}"
case "$mode" in read|rehearse|apply|verify) ;; *) exit 2 ;; esac
docker cp "$repo_root/server/tools/split-inbound-completion-refresh.mjs" mbbs-operator-app-app-1:/app/tools/split-inbound-completion-refresh.mjs
docker exec -i -w /app/tools mbbs-operator-app-app-1 node --input-type=module - "$mode" < "$repo_root/server/tools/split-inbound-completion-live.mjs"
