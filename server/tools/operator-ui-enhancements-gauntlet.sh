#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
reports="${server_root}/test-artifacts/operator-ui-enhancements"
compose=(docker compose -p mbbs-operator-ui-test -f "${repo_root}/docker-compose.mbt-test.yml" -f "${server_root}/test/operator-ui-enhancements.compose.yml" --profile tools --profile runtime --profile e2e)
cd "${repo_root}"
mkdir -p "${reports}"
# Remove only this task's disposable coverage, keeping the earlier RED evidence.
rm -rf "${reports}/coverage-tmp"
mkdir -p "${reports}/coverage-tmp"

python3 - "${repo_root}" "${reports}" <<'PY'
import hashlib, json, re, subprocess, sys
from pathlib import Path
root, reports = map(Path, sys.argv[1:])
targets = ['server/public/operator.js', 'server/src/delivery-repository.js']
diff = subprocess.run(['git','diff','--unified=0','--',*targets], cwd=root, text=True, check=True, capture_output=True).stdout
changed, current, number = {}, None, 0
for line in diff.splitlines():
    if line.startswith('+++ b/server/'):
        current = line[len('+++ b/server/'):]
        changed[current] = []
    elif match := re.match(r'@@ -[^+]*\+(\d+)', line):
        number = int(match[1])
    elif current and line.startswith('+') and not line.startswith('+++'):
        changed[current].append(number)
        number += 1
    elif current and line.startswith(' '):
        number += 1
(reports/'changed-lines.json').write_text(json.dumps(changed, indent=2)+'\n')
files = [root/p for p in targets] + [root/'server/public'/p for p in ['operator.css','operator.html','i18n.js','service-worker.js']]
files.extend(root/p for p in [
    'docker-compose.mbt-test.yml', 'server/package.json', 'server/package-lock.json',
    'server/src/operator-camera-schedule-harness.js', 'server/src/operator-return-ui-harness.js',
    'server/test/mbt/unit/operator-page-confirm-ui.contract.test.js',
    'server/test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js',
    'server/test/mbt/unit/operations-navigation-enhancements.test.js'
])
for pattern in ['test/**/operator-ui-*', 'tools/operator-ui-*']:
    files.extend(p for p in (root/'server').glob(pattern) if p.is_file() and not p.name.endswith('evidence.md'))
manifest = {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))}
(reports/'source-state.json').write_text(json.dumps(manifest, indent=2)+'\n')
PY

"${compose[@]}" up -d --wait db
"${compose[@]}" images --format json > "${reports}/images.json"
"${compose[@]}" run --rm test node --version > "${reports}/toolchain.log" 2>&1
"${compose[@]}" run --rm migrate > "${reports}/migrations.log" 2>&1
if [[ "${1:-}" != "--focused" ]]; then
  # The full-suite runner resets base database connections while cloning per-file DBs.
  "${compose[@]}" stop app
  "${compose[@]}" run --rm test npm run test:mbt > "${reports}/full-suite.log" 2>&1
  tail -n 1 "${reports}/full-suite.log"
fi

"${compose[@]}" run --rm -e NODE_V8_COVERAGE=/app/test-artifacts/operator-ui-enhancements/coverage-tmp test \
  node --test --test-concurrency=1 test/mbt/unit/operator-ui-enhancements.test.js test/mbt/integration/operator-ui-enhancements.test.js \
  > "${reports}/focused.log" 2>&1
"${compose[@]}" run --rm test npm run syntax:legacy > "${reports}/syntax.log" 2>&1
"${compose[@]}" run --rm test node --check src/delivery-repository.js >> "${reports}/syntax.log" 2>&1
"${compose[@]}" run --rm test node tools/operator-ui-types.mjs > "${reports}/types-summary.log" 2>&1
"${compose[@]}" run --rm test npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  test/mbt/e2e/operator-ui-enhancements.spec.js test/mbt/unit/operator-ui-enhancements.test.js \
  test/mbt/integration/operator-ui-enhancements.test.js test/support/operator-ui-enhancements-fixture.mjs \
  test/support/operator-ui-static-server.mjs tools/operator-ui-types.mjs tools/operator-ui-mutations.mjs tools/operator-ui-coverage.mjs \
  > "${reports}/lint.log" 2>&1
"${compose[@]}" run --rm test node tools/operator-ui-mutations.mjs > "${reports}/mutations.log" 2>&1

"${compose[@]}" up -d --wait app
"${compose[@]}" run --rm -e OPERATOR_UI_COVERAGE=1 e2e npx playwright test \
  --config test/operator-ui-enhancements.playwright.config.mjs \
  test/mbt/e2e/operator-ui-enhancements.spec.js test/mbt/e2e/operator-page-confirm.spec.js \
  test/mbt/e2e/operator-customer-pickup-photo-gate.spec.js test/mbt/e2e/operator-fulfillment-long-group-layout.spec.js \
  > "${reports}/browser.log" 2>&1
"${compose[@]}" run --rm test node tools/operator-ui-coverage.mjs > "${reports}/coverage.log" 2>&1
"${compose[@]}" run --rm test node test/support/scan-diff-secrets.mjs \
  public/operator.js public/operator.css public/operator.html public/i18n.js public/service-worker.js \
  src/delivery-repository.js test/operator-ui-enhancements-spec.md \
  test/mbt/e2e/operator-ui-enhancements.spec.js test/mbt/unit/operator-ui-enhancements.test.js \
  test/mbt/integration/operator-ui-enhancements.test.js test/support/operator-ui-enhancements-fixture.mjs \
  tools/operator-ui-types.mjs tools/operator-ui-mutations.mjs tools/operator-ui-coverage.mjs \
  > "${reports}/secrets.log" 2>&1
git diff --check
python3 - "${repo_root}" "${reports}" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, reports = map(Path, sys.argv[1:])
manifest = json.loads((reports/'source-state.json').read_text())
changed = [name for name, digest in manifest.items() if hashlib.sha256((root/name).read_bytes()).hexdigest() != digest]
if changed:
    raise SystemExit('Source changed during validation: '+', '.join(changed))
(reports/'source-verified.log').write_text(f'{len(manifest)} source files unchanged throughout validation.\n')
PY
printf 'Operator UI checks complete. Evidence: %s\n' "${reports}"
