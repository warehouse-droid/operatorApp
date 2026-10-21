"""Report the availability correction using retained test and read-only live evidence."""
import hashlib,json,pathlib,re

server=pathlib.Path(__file__).resolve().parents[1]
out=server/'test-artifacts/stock-check'
release=server/'deployments/stock-check-20261014'
def data(name):return json.loads((out/name).read_text())
def counts(name):
    log=(out/name).read_text()
    return tuple(int(re.search(r'^# '+key+r' (\d+)$',log,re.M)[1]) for key in ['pass','fail'])

normal=counts('final.log');shuffled=counts('final-shuffled.log')
assert normal==(83,0) and shuffled==(83,0)
mutants=data('mutations.json')
assert len(mutants)==8 and all(run['killed'] for item in mutants for run in item['runs'])
assert counts('property-availability-green.log')==(8,0)
assert counts('browser-availability-mutant.log')==(5,1)
assert 'Stock confirmed' in (out/'browser-availability-mutant.log').read_text()
assert 'Secret scan passed' in (out/'static-secrets.log').read_text()
assert 'app-1 Healthy' in (out/'boot-green.log').read_text()
live=data('availability-live-validated.json')
assert live['readOnly'] and live['legacy']['auditPreserved']
assert live['legacy']['presentedStatus']=='availability_unverified'
assert live['urban']['parsed']['status']=='in_production'
assert live['urban']['parsed']['eta']=='2026-10-20'
deploy=data('deployment.json');assert deploy['healthy'] and deploy['onlyAppChanged']
cleanup=data('final-host-cleanup.json')
assert cleanup['healthy'] and not cleanup['testContainers'] and not cleanup['testNetworks'] and not cleanup['testVolumes']
source=json.loads((release/'candidate-source.json').read_text())
published=json.loads((release/'published-source.json').read_text())
assert published=={key:value for key,value in source.items() if key!='Dockerfile'}
before=json.loads((server/'deployments/stock-check-availability-20261014/before-published-source.json').read_text())
changed=sorted(key for key,value in published.items() if before.get(key)!=value)
assert changed==sorted(['src/stock-check/domain.js','src/stock-check/repository.js','src/stock-check/unilock-dom.js',
    'src/stock-check/unilock-stock.js','public/scm-stock-check.js','public/scm-stock-check.html'])
source_hash=hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest()
coverage=data('coverage/coverage-summary.json')['total']
summary={'tier':3,'specApproval':'not obtained (autonomous run)','tests':normal,'shuffledTests':shuffled,
    'domainVaultMutants':8,'uiAvailabilityMutants':1,'changedPaths':changed,'sourceHash':source_hash,
    'imageId':cleanup['imageId'],'live':live,'deployment':deploy,'cleanup':cleanup,'nodeCoverage':coverage}
(out/'availability-evidence-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
rows='\n'.join('| '+row['sku']+' | '+str(row['quantity'])+' | '+row['availabilityText'].replace('|','/')+' | '+row['parsed']['status']+' |' for row in live['cart'])
report=f"""# Stock Check availability correction

Unilock accepts production items into its cart. Cart acceptance alone therefore
cannot establish immediate stock. New confirmations require the exact SKU,
full bundle increment, expected pickup/date, unchanged other cart lines, and
Available/In Stock on that same row. Production schedules retain their vendor
text and ETA and appear as In production. Missing, conflicting or unfamiliar
labels become a scrape failure for SCM review. Known production on the selected
product label/BNDL option is reported before Add to Cart, without adding a line.
Each operation records its step status and private screenshots. Cart evidence
scrolls the exact matching row into view so its Availability column is visible.

Tier 3. **Spec approval: not obtained (autonomous run).** User observations
authorized this correction. The append-only acceptance specification is
[Clarification I](stock-check-spec.md#clarification-i--vendor-availability-is-separate-from-cart-acceptance).

## Live validation

At {live['at']}, the saved vendor login was used for a read-only portal inspection.
No Add to Cart, shipment, pickup, quantity or requested-date changes were made.

| Exact cart SKU | Existing bundles | Vendor Availability | Parsed status |
| --- | --- | --- | --- |
{rows}

The authenticated selected Urban product also reported
`{live['urban']['availabilityText']}`. The current parser classified it as
in_production with ETA **2026-10-20**, using its dedicated product label.
The portal's product availability was absent in an anonymous inspection;
authentication is required. Cart labels use the row's `_availability` element.

Historical job `{live['legacy']['id']}` now presents Availability unverified
with accepted quantity {live['legacy']['acceptedQuantity']} and no verified stock
quantity. Its original database result is preserved for audit. The earlier
cart-only claim in [the original report](stock-check-evidence.md) is corrected.
The catalog still contains {live['catalogCount']} saved variants.

## Executed checks

- Complete Stock Check tests: **83 passed, 0 failed**, including PostgreSQL,
  native portal fixtures and Chromium. Shuffled file order with seed 20261014:
  **83 passed, 0 failed**. Both runs mounted the reviewed isolated candidate.
- Eight properties, 150 generated cases each. Eight domain/vault mutants were
  killed by unit tests and again by properties alone. These include scheduled
  production becoming immediate stock, unknown labels becoming stock, and
  bypassing Availability after cart acceptance. Source was unchanged by mutation.
- A separate UI mutant that displays In production as Stock confirmed was
  killed by the browser result/ETA assertion (5 passed, 1 failed). The original
  browser RED had a queued-job timing race; it is not used as evidence of that
  assertion. Synchronization was corrected without weakening the assertions.
- Availability domain, real DOM, native stock, PostgreSQL legacy-result and
  property checks failed before their fixes; their RED and GREEN logs are
  retained. `parser-availability-red.log` accidentally ran units; the genuine
  DOM RED is `parser-availability-dom-red.log` (4 passed, 2 failed).
- Static lint, limited check-JS types and secret scanning passed. A complexity
  finding was corrected by extracting the availability helper; the existing
  complexity limit of 16 was retained. The exact release image started healthy
  with synthetic data in the bounded isolated Compose stack.
- Node coverage: {coverage['lines']['covered']}/{coverage['lines']['total']}
  lines ({coverage['lines']['pct']}%), {coverage['branches']['covered']}/{coverage['branches']['total']}
  branches ({coverage['branches']['pct']}%). Serialized browser DOM/calendar
  functions execute in Chromium and have limited Node instrumentation. Defensive
  branches and complete changed-line coverage remain gaps; this is bounded
  evidence, not proof of every behavior.

Native fixtures verify accepted production carts retain ETA and restore the
baseline, early product production skips Add and restores settings, and unknown
Availability requires SCM review while restoring the cart. The UI verifies
production/ETA and the protected screenshot. Repository tests verify historical
positives become unverified without overwriting audit data. Existing quantity,
pickup/date, cleanup, encryption, authorization and scrolling tests still pass.

## Release and reproduction

Deployment verified {deploy['at']}; application health and all three Stock Check
routes passed. Only the application container changed. Shared application,
sidebar, menu and dependency files were pinned to their existing live bytes;
unrelated workspace changes were excluded. The six changed production paths
are recorded in `availability-evidence-summary.json`. Runtime image:
`{cleanup['imageId']}`. Candidate manifest hash: `{source_hash}`.

From the repository root, run the bounded registered-teardown runner with
`STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final`
and `final-shuffled`; use stages `static`, `property`, `browser-availability-mutant`
and `boot-green` for the other layers. Mutation stage is intentionally nonzero.
Generate this report with `python3 server/tools/stock-check-evidence.py` after
read-only live validation and final cleanup. Captured candidate, pinned Docker
image/toolchain and installed mbbs-tests.slice are required. Disposable tests
use synthetic credentials and data. The full unrelated legacy suite was not
rerun for this six-file correction; its earlier findings remain historical.

All task-owned test containers, databases and unused networks were removed;
both docker ps and docker ps -a were checked. Production data and operational
audit records were retained. Other tasks' active test projects, if present, are
listed separately in the cleanup artifact and remain their owners' responsibility.

Known limits: Availability is vendor-reported status rather than an independent
warehouse count. ETA is a vendor production schedule and can change. Production
on a cumulative cart quantity with an existing matching line requires SCM review
of the requested increment. Concurrent human cart edits are outside the worker
lock; interrupted jobs still require review. Other vendor adapters remain pending.
"""
(server/'test/stock-check-availability-evidence.md').write_text(report)
print(json.dumps({'report':'test/stock-check-availability-evidence.md','tests':normal,'sourceHash':source_hash}))
