"""Capture verified sources and report the scoped customer linking release."""
import argparse, datetime, hashlib, json, re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ART = SERVER / 'test-artifacts/field-sales/customer-links'
BASE = json.loads((SERVER / 'test/field-sales/customer-links-baseline.json').read_text())['hashes']
FILES = sorted([*BASE, 'public/field-sales/customer-search.js'])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def inputs():
    (ART / 'verified-source.json').write_text(json.dumps({f: sha(SERVER / f) for f in FILES}, indent=2))
    print(json.dumps({'inputs': True, 'files': len(FILES)}))

def report():
    source = json.loads((ART / 'verified-source.json').read_text())
    assert source == {f: sha(SERVER / f) for f in FILES}, 'Source changed during verification'
    log = (ART / 'final-tests.log').read_text()
    passes, failures = re.findall(r'^# pass (\d+)$', log, re.M), re.findall(r'^# fail (\d+)$', log, re.M)
    assert passes and failures == ['0'], 'Field Sales tests failed'
    for name in ['lint.log', 'types.log']:
        assert not (ART / name).read_text().strip(), name + ' failed'
    browser = json.loads((ART / 'customer-links-browser.json').read_text())
    regression = json.loads((ART / 'customer-browser.json').read_text())
    assert browser['passed'] and regression['passed']
    for name in ['final-browser.log', 'combined-browser.log']:
        assert '"passed":true' in (ART / name).read_text(), name + ' did not complete'
    result = {'passed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'tests': int(passes[-1]), 'browser': browser, 'quoteRegression': regression,
              'source': source, 'existing': sorted(BASE), 'baseline': BASE,
              'sourceTreeSha256': hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()}
    (ART / 'customer-links-checks.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'passed': True, 'tests': result['tests'], 'customerScenarios': len(browser['results']), 'quoteScenarios': len(regression['results'])}))

parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['inputs', 'report'])
globals()[parser.parse_args().action]()
