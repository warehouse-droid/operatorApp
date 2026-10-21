#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
bash server/tools/pob04042-ir/run-checks.sh final
bash server/tools/pob04042-ir/run-quality.sh
bash server/tools/pob04042-ir/run-integration.sh final
