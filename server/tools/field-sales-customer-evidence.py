"""Prepare verification inputs and summarize the Field Sales customer release."""
import argparse, datetime, hashlib, json, re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ART = SERVER / 'test-artifacts/field-sales/customer-quotes'
BASE = json.loads((SERVER / 'test/field-sales/customer-quotes-baseline.json').read_text())
NEW = ['src/field-sales/customers.js', 'src/field-sales/company-quotes.js', 'src/field-sales/company-pdf.js',
       'src/field-sales/orders.js', 'src/field-sales/evidence.js', 'public/field-sales/customers.js',
       'public/field-sales/identity.js', 'migrations/213_field_sales_customer_quotes.sql']
NEW += [str(p.relative_to(SERVER)) for p in (SERVER / 'src/field-sales/fonts').iterdir() if p.is_file()]
FILES = sorted(set(BASE['hashes']) | set(NEW))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def inputs():
    ART.mkdir(parents=True, exist_ok=True)
    (ART / 'source-files.json').write_text(json.dumps(FILES, indent=2))
    (ART / 'baseline-text.json').write_text(json.dumps(BASE['text']))
    (ART / 'verified-source.json').write_text(json.dumps({f: sha(SERVER / f) for f in FILES}, indent=2))
    print(json.dumps({'files': len(FILES), 'inputs': True}))

def report():
    source = json.loads((ART / 'verified-source.json').read_text())
    assert source == {f: sha(SERVER / f) for f in FILES}, 'Source changed during verification'
    def tests(name):
        log = (ART / name).read_text()
        passed, failed = re.findall(r'^# pass (\d+)$', log, re.M), re.findall(r'^# fail (\d+)$', log, re.M)
        assert passed and failed == ['0'], name + ' failed'
        return int(passed[-1])
    count = tests('final-tests.log')
    assert tests('shuffled-tests.log') == count
    assert not (ART / 'lint.log').read_text().strip()
    assert not (ART / 'types.log').read_text().strip()
    browser = json.loads((ART / 'customer-browser.json').read_text())
    mutations = json.loads((ART / 'mutations.json').read_text())
    coverage = json.loads((ART / 'changed-lines.json').read_text())
    assert browser['passed'] and mutations['passed']
    # The release includes only this task's changed files over the already
    # deployed UUID hotfix. All other shared app files stay in the base image.
    baseline = dict(BASE['hashes'])
    hotfix = SERVER / 'test-artifacts/field-sales/customer-quotes/uuid-checks.json'
    if hotfix.exists(): baseline.update(json.loads(hotfix.read_text())['source'])
    changed = {f: digest for f, digest in source.items() if baseline.get(f) != digest}
    existing = [f for f in changed if f in baseline]
    forbidden = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}')
    for f in changed:
        if (SERVER / f).suffix in {'.js', '.sql', '.json', '.css'}:
            assert not forbidden.search((SERVER / f).read_text()), 'Potential secret in ' + f
    result = {'passed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'tests': count, 'browser': browser, 'mutants': mutations,
              'coverage': {'changed': coverage['changed'], 'covered': coverage['covered'], 'unmeasured': coverage['unmeasured']},
              'source': changed, 'existing': existing, 'baseline': {f: baseline[f] for f in existing},
              'verifiedSource': source, 'tools': {'node':'20.20.2','typescript':'7.0.2','eslint':'10.8.0','c8':'12.0.0','playwright':'1.62.1','fast-check':'4.9.0','pg':'8.21.0','pdfkit':'0.20.2','sharp':'0.35.3'},
              'externalValidation': 'Not run: FIELD_SALES_RESTLET_URL is absent; server and setting write gates remain off.'}
    (ART / 'customer-checks.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ['passed','tests','coverage','externalValidation']}))

parser=argparse.ArgumentParser();parser.add_argument('action',choices=['inputs','report'])
if parser.parse_args().action=='inputs': inputs()
else: report()
