#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/apps/operatorApp
python3 server/tools/bin-order-workflow-source.py
python3 server/tools/bin-order-workflow-capabilities.py
bash server/tools/bin-order-workflow-check.sh final-gauntlet db-command node tools/bin-order-workflow-gauntlet.mjs
