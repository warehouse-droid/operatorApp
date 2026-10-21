#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
bash server/tools/customer-webhook-test.sh node tools/customer-webhook-gauntlet.mjs
