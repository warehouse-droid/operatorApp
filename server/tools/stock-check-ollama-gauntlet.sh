#!/usr/bin/env bash
set -euo pipefail
stock_ollama_server=$(cd "$(dirname "$0")/.." && pwd)
cd "$stock_ollama_server"
export STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-ollama-20261015/candidate
export STOCK_CHECK_RUNTIME_IMAGE=mbbs-operator-app:stock-check-ollama-20261015
export STOCK_CHECK_TEST_ARTIFACTS="$stock_ollama_server/test-artifacts/stock-check-ollama"
python3 - <<'PY'
import datetime,json,pathlib,shutil,time
out=pathlib.Path('test-artifacts/stock-check-ollama');stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');archive=out/('prior-gauntlet-'+stamp);archive.mkdir()
for name in ['coverage','browser-coverage.json','lines-browser-coverage.json','lines-browser-coverage-istanbul.json']:
 p=pathlib.Path('test-artifacts/stock-check')/name
 if p.exists():shutil.move(str(p),str(archive/name))
for name in ['final-ollama.log','static-ollama-final.log']:
 p=out/name
 if p.exists():shutil.copy2(p,archive/name)
(out/'gauntlet-start.json').write_text(json.dumps({'started':time.time(),'at':stamp})+'\n')
PY
bash tools/stock-check-tests.sh static-ollama-final
bash tools/stock-check-tests.sh final-ollama
bash tools/stock-check-tests.sh ollama-properties-final
STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/backorder-requests.test.js bash tools/stock-check-tests.sh full-ollama-backorder
STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/special-stock-check-editing-browser.test.js bash tools/stock-check-tests.sh full-ollama-special
bash tools/stock-check-tests.sh boot-ollama
