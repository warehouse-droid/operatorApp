"""Apply only this task's popup to the frozen deployed frontend."""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/receiving-followup'
BEFORE = ARTIFACT / 'live-before/public'
STAGE = ARTIFACT / 'release/public'
STAGE.mkdir(parents=True, exist_ok=True)
for file in BEFORE.iterdir():
    shutil.copy2(file, STAGE / file.name)
source = (ROOT / 'public/operator.js').read_text()
local_before = (ARTIFACT / 'baseline/public/operator.js').read_text()
live = (BEFORE / 'operator.js').read_text()


def section(text, start):
    return text[text.index(start):text.index('function stopReceiptCamera()')]


old = section(local_before, 'async function startReceipt()')
assert old == section(live, 'async function startReceipt()'), 'Deployed receiving flow differs; rebase the popup'
new = section(source, 'let receivingPartialConfirmation = null;')
assert live.count(old) == 1
(STAGE / 'operator.js').write_text(live.replace(old, new))
version = '20260917-receiving-followup-v1'
html = re.sub(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + version, (BEFORE / 'operator.html').read_text())
html = html.replace('    <link rel="stylesheet" href="/i18n.css',
    '    <link rel="stylesheet" href="/operator-receiving-confirmation.css?v=' + version + '" />\n    <link rel="stylesheet" href="/i18n.css')
(STAGE / 'operator.html').write_text(html)
worker = re.sub(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + version + '";', (BEFORE / 'service-worker.js').read_text())
worker = re.sub(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + version, worker)
worker = worker.replace('  "/i18n.css', '  "/operator-receiving-confirmation.css?v=' + version + '",\n  "/i18n.css')
(STAGE / 'service-worker.js').write_text(worker)
shutil.copy2(ROOT / 'public/operator-receiving-confirmation.css', STAGE / 'operator-receiving-confirmation.css')
print('Prepared the deployed frontend plus the receiving confirmation popup.')
