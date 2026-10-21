#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh -n tools/scm-po-text-verify.sh
python3 tools/scm-po-text-run.py sync
python3 tools/scm-po-text-run.py checks node tools/scm-po-text-check.mjs
python3 tools/scm-po-text-run.py release-secrets node test/support/scan-diff-secrets.mjs tools/scm-po-text-deploy.py tools/scm-po-text-verify.sh
python3 tools/scm-po-text-run.py collect
