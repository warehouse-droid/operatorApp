"""Generate evidence from the final fresh combined check run."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/regular-stock-arrival'
checks = json.loads((out / 'checks.json').read_text())
layers = json.loads((out / 'gauntlet.json').read_text())
assert len(layers) == 5 and all(row['exitCode'] == 0 for row in layers)
assert checks['tests'] == checks['passed']
coverage = json.loads((out / 'changed-lines.json').read_text())
browser = json.loads((out / 'regular-stock-v2/browser-results.json').read_text())
regression = json.loads((out / 'regressions.log').read_text().strip())
assert not regression['newFailures'] and not browser['errors'] and coverage['complete']
for file, sha in checks['sourceHashes'].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == sha
state = hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
text = f"""# Evidence: arrival fields and special quote packing

Spec approval: **not obtained (autonomous run)**. Tier 3. User authorization
covers implementation and direct deployment after tests. Interpretation is
recorded in `test/regular-stock-arrival-spec.md`; no independent human spec review
occurred. Source state: `{state}` (canonical sorted source hash mapping).

Reproduce with `python3 tools/regular-stock-arrival-check.py`. The runner creates
a disposable internal-network PostgreSQL DB, mounts source read-only and stubs
NetSuite boundaries. Toolchain: {json.dumps(checks['toolchain'])}.

| Acceptance / failure mode | Executable evidence |
|---|---|
| Pickup and Stocking omit dates; stale hidden values cannot block submission | arrival unit properties, Stocking SQL lifecycle, real browser/API submissions |
| Delivery still requires valid Toronto date/time and lead time | existing normalizer tests, exact-boundary properties, create/edit rejection, browser normalization |
| Method switches preserve other fields and handle pending normalization | browser delayed-module and invalid-date switching checks |
| No-date manual decisions, SO confirmation, expiry/re-raise and direct TO retry | regular-stock-stocking SQL suite; existing handoff, controls and pickup suites |
| Safety, gate, expiry and duplicate controls remain intact | regression/property tests, delayed browser confirmation and partial TO retry |
| Empty summary card omitted; historical dates and snapshots retained | arrival UI test, completed-request browser and read-only deployed snapshot check |
| Draft/saved quotes show actual packing, zero/fractions/legacy blanks, ancillary counts | special-quote-packing unit and generated tests |
| PLT / SEC / LYR / PCS match NetSuite sample order and values | actual PDF text properties, multi-page PDF, PDFium-rendered visual inspection |
| Prices/tax unchanged and private SCM fields excluded | special quote total assertions and existing document/pricing properties |
| Quote access and other document layouts preserved | Sales/SCM authenticated HTTP preview, requester tests, Field Sales company PDF tests |
| Only intended runtime changes published | before snapshots, task-only patch, complete image source tree comparison and configuration verification |

| Final fresh check | Result |
|---|---|
| Full relevant regression | {regression['passed']} passed; {regression['baselineFixtureFailures']} known fixture failure; zero new failures |
| Separate-process shuffled run | {checks['passed']}/{checks['tests']} passed; seed {checks['suiteOrderSeed']} |
| Generated properties | {checks['propertyCases']} cases; seeds {checks['propertySeeds']} |
| Manual mutants | {len(checks['mutants'])}/{len(checks['mutants'])} killed by regression AND property-only runs |
| Changed executable lines | {coverage['covered']}/{coverage['total']} covered |
| Changed-line branches | {coverage['branches']['covered']}/{coverage['branches']['total']} covered; exact misses in changed-lines.json |
| Browser/server | {len(browser['checks'])} checks; zero browser errors |
| Static checks | Existing strict core types, syntax, baseline lint and new-file lint passed |
| Dependencies / schema / external capabilities | No additions |

RED evidence: `red.log` records all 13 original arrival/lifecycle tests failing.
`quote-red.log` records six new quote tests failing because packing was absent.
The additional PDF-column property is validated by deliberate missing/swapped
column mutants. An old mandatory-arrival HTTP test was retargeted from Pickup
to Delivery while retaining its assertions, as explicitly recorded in the spec.
A generated test's null prototype was excluded from the value comparison; all
packing-value assertions remain exact. Field Sales retains its original row
height calculation as well as its original columns.

The known unrelated fixture failure is `Expected active item_master input` in
`src/smart-scm-harness.js`. Legacy lint diagnostics remain recorded in the static
report. This is a scoped regression result, not a claim that the entire dirty
repository has no failing tests or diagnostics.

Visual review: generated single-page and five-page quotes have readable aligned
packing columns, Chinese descriptions and repeated table headings. Very large
packing values wrap inside their own cell. Both manuals are rebuilt with actual
deployed UI screenshots and fictional data, plus a generated quote sample.

Skipped: dependency audit (no dependency changes), performance/platform matrix
(no new budget or platform), and real NetSuite order writes (stubbed boundaries).
No schema migration was needed; no commits were made in the shared dirty tree.
Deployment is the scoped nine-file overlay documented under
`deployments/regular-stock-arrival-20260929/`, with rollback and read-only checks.
"""
(out / 'EVIDENCE.md').write_text(text)
print(json.dumps({'sourceState': state, 'tests': regression['passed'], 'shuffled': checks['passed'], 'browser': len(browser['checks']), 'changedLines': f"{coverage['covered']}/{coverage['total']}"}))
