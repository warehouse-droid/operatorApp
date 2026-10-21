#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
bash server/tools/receipt-extra-charges/run.sh final
bash server/tools/receipt-extra-charges/quality.sh
python3 server/tools/receipt-extra-charges/report.py
