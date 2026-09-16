#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
bash tools/operator-receiving-identity-test.sh node tools/operator-receiving-identity-gauntlet.mjs "$@"
bash tools/operator-receiving-identity-test.sh node tools/operator-receiving-identity-reversed.mjs
docker run --rm --network none --ipc=host --user 0:0 \
  -v "$server_root/public:/app/public:ro" -v "$server_root/tools:/app/tools:ro" \
  -v "$server_root/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-mbt-p1-test-e2e:latest tools/operator-receiving-identity-browser.mjs
