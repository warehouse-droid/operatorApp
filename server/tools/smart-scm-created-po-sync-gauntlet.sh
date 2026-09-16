#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
bash tools/smart-scm-created-po-sync-test.sh node tools/smart-scm-created-po-sync-gauntlet.mjs "$@"
docker run --rm --network none --ipc=host --user 0:0 \
  -e MBT_TEST_ISOLATED=1 \
  -v "$server_root/src:/app/src:ro" \
  -v "$server_root/public:/app/public:ro" \
  -v "$server_root/tools:/app/tools:ro" \
  -v "$server_root/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-mbt-p1-test-e2e:latest \
  tools/smart-scm-created-po-sync-browser.mjs
