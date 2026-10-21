#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh -n tools/special-po-pallet-routing-verify.sh
python3 tools/special-po-pallet-routing-run.py sync
python3 tools/special-po-pallet-routing-run.py gauntlet node tools/special-po-pallet-routing-check.mjs
python3 tools/special-po-pallet-routing-run.py coverage node tools/special-po-pallet-routing-coverage.mjs
python3 tools/special-po-pallet-routing-run.py live-tool-syntax node --check tools/special-po-pallet-routing-live.mjs
python3 tools/special-po-pallet-routing-run.py extra-secrets node test/support/scan-diff-secrets.mjs tools/special-po-pallet-routing-deploy.py tools/special-po-pallet-routing-run.py tools/special-po-pallet-routing-repair-000017.mjs tools/special-po-pallet-routing-coverage.mjs tools/special-po-pallet-routing-live.mjs tools/special-po-pallet-routing-verify.sh
python3 tools/special-po-pallet-routing-run.py collect
