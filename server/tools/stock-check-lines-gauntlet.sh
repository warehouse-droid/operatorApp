#!/usr/bin/env bash
set -euo pipefail
stock_lines_server=$(cd "$(dirname "$0")/.." && pwd)
cd "$stock_lines_server"
export STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-lines-20261014/candidate
export STOCK_CHECK_RUNTIME_IMAGE=mbbs-operator-app:stock-check-lines-20261014
export STOCK_CHECK_TEST_ARTIFACTS="$stock_lines_server/test-artifacts/stock-check-lines"
python3 - <<'PY'
import datetime,json,pathlib,shutil,time
out=pathlib.Path('test-artifacts/stock-check-lines');out.mkdir(parents=True,exist_ok=True)
archive=out/('prior-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));archive.mkdir()
for name in ['coverage','browser-coverage.json','lines-browser-coverage.json','lines-browser-coverage-istanbul.json']:
 p=pathlib.Path('test-artifacts/stock-check')/name
 if p.exists():shutil.move(str(p),str(archive/name))
(out/'gauntlet-start.json').write_text(json.dumps({'started':time.time(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n')
PY
bash tools/stock-check-tests.sh static-lines-final
bash tools/stock-check-tests.sh final-lines
bash tools/stock-check-tests.sh final-lines-shuffled
bash tools/stock-check-tests.sh matching-lines-final
STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/backorder-requests.test.js bash tools/stock-check-tests.sh full-lines-backorder
STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/special-stock-check-editing-browser.test.js bash tools/stock-check-tests.sh full-lines-special
bash tools/stock-check-tests.sh boot-lines
python3 tools/stock-check-lines-evidence.py
