"""Summarize the final fresh run; all counts come from saved check artifacts."""
import hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'test-artifacts/regular-stock-stocking'
checks=json.loads((out/'checks.json').read_text())
layers=json.loads((out/'gauntlet.json').read_text())
assert len(layers)==5 and all(x['exitCode']==0 for x in layers)
assert checks['tests']==checks['passed']
coverage=json.loads((out/'changed-lines.json').read_text())
browser=json.loads((out/'regular-stock-v2/browser-results.json').read_text())
regression=json.loads((out/'regressions.log').read_text().strip())
assert not regression['newFailures'] and not browser['errors'] and coverage['complete']
for file,sha in checks['sourceHashes'].items():
 assert hashlib.sha256((root/file).read_bytes()).hexdigest()==sha
state=hashlib.sha256(json.dumps(checks['sourceHashes'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
text=f"""# Evidence — Stocking and customer Pickup (Tier 3)

Spec approval: **not obtained (autonomous run)**. The user explicitly requested this behavior and authorized deployment after tests. Confidence in the interpretation is limited to the recorded specification: `test/regular-stock-stocking-spec.md`.

Entry point: `python3 tools/regular-stock-stocking-check.py`. Uses disposable PostgreSQL and Docker images with outbound NetSuite disabled/stubbed. Source state: `{state}` (SHA-256 of canonical sorted source hash mapping in `checks.json`; this script reproduces it). Toolchain: {json.dumps(checks['toolchain'])}.

| Requirement | Evidence | Result |
|---|---|---|
| Pickup pre-approval without lead time; Delivery preserves its boundary | regular-stock-methods unit properties; regular-stock-stocking SQL; authenticated browser submission | Pass |
| All items remain at/above safety and switch must be enabled | quantity aggregation and gate tests, generated truth table, manual-decision SQL | Pass |
| Stocking always manual and direct TO only | Stocking unit/SQL, external-workflow HTTP and real adapter with transport stub | Pass |
| Cross-workflow calls reject; legacy direct TO retries reuse transfers | regular-stock-stocking integration; regular-stock-pickup integration | Pass |
| SO quantities, reuse, leases and idempotent routing remain guarded | controls, handoff, external-workflow and ancillary suites | Pass |
| Pickup expiry/re-raise and Stocking exclusion | generated expiry properties; SQL re-raise; browser | Pass |
| Three methods, correct queues/reasons, Chinese labels, final snapshots | UI unit tests and browser checks | Pass |
| Busy status clears after auto-approval and duplicate actions stay locked while processing | browser immediate Pickup and delayed preview/conversion checks | Pass |

## Final fresh run

| Layer | Result |
|---|---|
| Full relevant regression run | {regression['passed']} passed; {regression['baselineFixtureFailures']} known fixture failure; zero new failures |
| Shuffled focused run | {checks['passed']}/{checks['tests']} passed; actual separate-process order, seed {checks['suiteOrderSeed']} |
| Properties | {checks['propertyCases']} generated cases across five properties; seeds {checks['propertySeeds']} |
| Manual mutation | {len(checks['mutants'])}/{len(checks['mutants'])} killed by regressions AND property-only tests |
| Changed executable lines | {coverage['covered']}/{coverage['total']} covered; no missing files |
| Branches on changed lines | {coverage['branches']['covered']}/{coverage['branches']['total']}; remaining branches listed in changed-lines.json |
| Browser/server | {len(browser['checks'])} checks; zero browser errors; desktop/mobile screenshots saved |
| Static checks | Syntax, strict core types and new-file lint passed; legacy lint baseline unchanged |
| Dependencies/capabilities | No dependency, schema, endpoint or outbound-service additions |

The existing smart-SCM fixture failure is `Expected active item_master input`. It predates these changes. Unchanged legacy lint diagnostics are retained in the static report; this is not a claim that repository-wide lint is clean.

RED is retained in `unit-red.tap`, `integration-red.tap`, and `pickup-button-red.log`. Old direct-Pickup tests were retargeted to Stocking because the user changed the requirement. A fixed-clock SO fixture now uses the same clock for both approval and routing. A browser check found the auto-approved SO button stayed disabled; the Sales screen now rerenders after clearing saving state, and the check passes without refresh.

Skipped: dependency vulnerability audit (no dependency changes), performance/version matrix (no requested budget or platform change), and live order creation (external writes are exercised through stubbed transport). Branch coverage is below 100%; the exact uncovered branches remain visible in the report. No real NetSuite orders were created by validation.

Deployment is a scoped overlay of {len(checks['sourceHashes'])} files onto the running image, with complete source-tree and configuration checks, active-operation checks and rollback. See `deployments/regular-stock-stocking-20260929/result.json` for the final deployment/read-only verification result.
"""
(out/'EVIDENCE.md').write_text(text)
print(json.dumps({'sourceState':state,'tests':regression['passed'],'shuffled':checks['passed'],'browser':len(browser['checks']),'changedLines':f"{coverage['covered']}/{coverage['total']}"}))
