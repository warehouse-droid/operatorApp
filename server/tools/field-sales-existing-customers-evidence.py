"""Summarize verification for existing NetSuite customer linking and Sales Orders."""
import argparse, datetime, hashlib, json, re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ART = SERVER / 'test-artifacts/field-sales/existing-customers'
BASE = json.loads((SERVER / 'test/field-sales/existing-customers-baseline.json').read_text())
NEW = ['public/field-sales/netsuite-customer-picker.js']
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
    existing_browser = json.loads((ART / 'existing-customers-browser.json').read_text())
    assert existing_browser['passed']
    site_browser = json.loads((ART / 'customer-links-browser.json').read_text())
    assert site_browser['passed']
    mutations = json.loads((ART / 'mutations.json').read_text())
    coverage = json.loads((ART / 'changed-lines.json').read_text())
    assert browser['passed'] and mutations['passed']
    assert mutations['killed'] == mutations['total'] == 6
    assert coverage['covered'] == coverage['changed'] and not coverage['unmeasured']
    # The release includes only this task's changed files over the currently
    # deployed customer release. All other shared app files stay in the base image.
    baseline = dict(BASE['hashes'])
    changed = {f: digest for f, digest in source.items() if baseline.get(f) != digest}
    existing = [f for f in changed if f in baseline]
    forbidden = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}')
    for f in changed:
        if (SERVER / f).suffix in {'.js', '.sql', '.json', '.css'}:
            assert not forbidden.search((SERVER / f).read_text()), 'Potential secret in ' + f
    result = {'passed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'tests': count, 'browser': browser, 'existingCustomerBrowser': existing_browser, 'siteCustomerBrowser': site_browser, 'mutants': mutations,
              'coverage': {'changed': coverage['changed'], 'covered': coverage['covered'], 'unmeasured': coverage['unmeasured']},
              'source': changed, 'existing': existing, 'baseline': {f: baseline[f] for f in existing},
              'verifiedSource': source, 'sourceTreeSha256':hashlib.sha256(json.dumps(source,sort_keys=True,separators=(',',':')).encode()).hexdigest(), 'tools': {'node':'20.20.2','typescript':'7.0.2','eslint':'10.8.0','c8':'12.0.0','playwright':'1.62.1','fast-check':'4.9.0','pg':'8.21.0','pdfkit':'0.20.2','sharp':'0.35.3'},
              'externalValidation': 'No live writes: server posting gate remains off and the dedicated RESTlet URL is absent.'}
    (ART / 'existing-customers-checks.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ['passed','tests','coverage','externalValidation']}))

parser=argparse.ArgumentParser();parser.add_argument('action',choices=['inputs','report'])
if parser.parse_args().action=='inputs': inputs()
else: report()
