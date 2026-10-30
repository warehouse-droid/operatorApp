#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname -- "$0")/../.."
bash server/tools/scm-po-to-handoff-baseline.sh
bash docker/run-isolated-tests.sh bash tools/scm-po-to-handoff-checks.sh
