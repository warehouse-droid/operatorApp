#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh -n tools/scm-po-text-refs-verify.sh
python3 tools/scm-po-text-refs-run.py sync
python3 tools/scm-po-text-refs-run.py checks node tools/scm-po-text-refs-check.mjs
python3 tools/scm-po-text-refs-run.py release-secrets node test/support/scan-diff-secrets.mjs tools/scm-po-text-refs-deploy.py tools/scm-po-text-refs-verify.sh
python3 tools/scm-po-text-refs-run.py collect
