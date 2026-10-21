"""Summarize retained Stock Check evidence without accessing vendor credentials."""
import hashlib,json,pathlib,re,runpy,sys

# Keep the original-release generator available only by explicit historical opt-in.
# The default report must reflect the corrected Availability rule.
if '--historical' not in sys.argv:
    runpy.run_path(str(pathlib.Path(__file__).with_name('stock-check-availability-evidence.py')),run_name='__main__')
    raise SystemExit(0)

server=pathlib.Path(__file__).resolve().parents[1]
out=server/'test-artifacts/stock-check'
release=server/'deployments/stock-check-20261014'
def data(name):return json.loads((out/name).read_text())
def counts(name):
    text=(out/name).read_text()
    passed=re.search(r'^# pass (\d+)$',text,re.M)
    failed=re.search(r'^# fail (\d+)$',text,re.M)
    assert passed and failed, 'Finish '+name+' first.'
    return int(passed[1]),int(failed[1])
normal=counts('final.log');shuffled=counts('final-shuffled.log')
assert normal==(69,0) and shuffled==(69,0)
reg=data('regressions.json');assert not reg['newFailedFiles'] and not reg['newFailingCases']
mut=data('mutations.json');assert len(mut)==5 and all(run['killed'] for item in mut for run in item['runs'])
runtime=data('runtime-mutations.json');assert len(runtime)==4 and all(item['killed'] for item in runtime)
cov=data('coverage/coverage-summary.json')['total']
ui=json.loads(re.findall(r'^\{.*\}$',(out/'browser-coverage.log').read_text(),re.M)[-1])
audit=data('dependency-audit.json');state=data('live-module-state.json');job=data('live-result.json')
assert job['result']['status']=='stock_confirmed' and job['result']['verifiedQuantity']==5
assert all(step['status']=='success' for step in job['steps'])
deploy=data('deployment.json');assert deploy['healthy'] and deploy['onlyAppChanged']
cleanup=data('final-host-cleanup.json');assert cleanup['healthy'] and cleanup['onlyProductionContainers'] and not cleanup['testNetworks'] and not cleanup['testVolumes']
assert 'Healthy' in (out/'boot-green.log').read_text()
assert 'Secret scan passed' in (out/'static-secrets.log').read_text()
source=json.loads((release/'candidate-source.json').read_text())
source_hash=hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest()
published=json.loads((release/'published-source.json').read_text())
assert published=={key:value for key,value in source.items() if key!='Dockerfile'}
published_hash=hashlib.sha256(json.dumps(published,sort_keys=True).encode()).hexdigest()
before=json.loads((release/'capture.json').read_text())
changed=sorted(key for key,value in source.items() if before['source_hashes'].get(key)!=value)
toolchain=server/'test-artifacts/mbr-contract/toolchain/node_modules'
versions={name:json.loads((toolchain/name/'package.json').read_text())['version'] for name in ['playwright','pg','express','c8','eslint','typescript','fast-check','axe-core']}
summary={'specApproval':'not obtained (autonomous run)','tier':3,'moduleTests':normal,'shuffledModuleTests':shuffled,
         'sourceHash':source_hash,'publishedSourceHash':published_hash,'changedPaths':changed,'versions':versions,
         'nodeCoverage':cov,'browserCoverage':ui,'domainVaultMutants':len(mut),'runtimeMutants':len(runtime),
         'newDependencyAdvisories':audit['newAdvisories'],'regressions':{key:reg[key] for key in ['filesPerRun','baselineFailedFiles','candidateFailedFiles','baselineTestsReported','candidateTestsReported','rawNewFailedFiles','resolvedTimeouts','newFailedFiles','newFailingCases']},
         'catalog':state,'liveJobId':job['id'],'liveResult':job['result'],'deployment':deploy}
(out/'evidence-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
text=f"""# SCM Stock Check — implementation and evidence

Implemented the requested SCM module with Product Pickup Points, Test Stock Check,
and Vendor Setup. Vendors have separate encrypted, named accounts and a selected
login. Unilock Ontario is the first tested adapter; other vendor methods remain
pending until implemented and tested.

Tier 3. **Spec approval: not obtained (autonomous run).** The user authorized this
module and live pilot; the specification was written for review without pausing
implementation. This evidence gives bounded confidence, not proof of all behavior.
Acceptance specification: [stock-check-spec.md](stock-check-spec.md).

## Live evidence

- Deployment verified {deploy['at']}; all three SCM routes return 200 and application health
  passes. Only the application container changed; database, webhook worker, and
  Ollama identities/settings were verified unchanged. Runtime image:
  `{json.loads((release/'state.json').read_text())['candidateImageId']}`.
- Saved {state['productCount']} exact Unilock colour/size variants: 190 Ayr,
  84 Gormley, 54 Pickering, 99 Georgetown. The remaining
  {state['pickupReviewCount']} are retained for review: 24 Chicago labels and
  167 missing labels. No category-based pickup guess is made. Endura Coping
  Oat Beige `177ECS0163703-0` is saved as Pickering.
- The selected named Unilock login is configured and verified. The encrypted
  account key is retained in application data with mode 0600; secrets are absent
  from source, job payloads, returned account objects and recorded failure text.
  The live anonymous stock-check API returns 401.
- Authorized live job `{job['id']}` confirmed **5 pallets** of Beacon Hill Smooth
  XL 6 cm Granite Fusion, exact SKU `0262XL0631907-0`, at Ayr on
  `{job['result']['requestDate']}`. All {len(job['steps'])} recorded steps passed.
  The cart reached 10 bundles: 5 existing + 5 tested. The original 5 and saved
  October 15 date were restored and independently reread by the checker.
  Two real JPEGs are stored in the authenticated SCM result. The cart overview
  image shows 10 bundles and the selected pickup/date; the product image shows
  the selected variant. Stock confirmation also checks the full parsed cart.

## Acceptance-to-test mapping

| Specification | Executed verification |
| --- | --- |
| 1: SCM module and navigation | Browser catalog/setup/test flows through actual app routes; release route checks |
| 2: Vendor logins and private secrets | Vault unit/property tests; PostgreSQL multiple-account/ownership tests; setup browser flow; router authorization/body tests |
| 3: Separate vendor methods | Repository rejects pending methods; setup browser displays pending adapter state |
| 4–5 and B–C: Exact selected labels/SKUs | DOM fixture tests distinguish selected Pickering from generic Ayr; catalog all-colour/dedup/space-SKU tests; live 618-variant capture |
| 6 and G: SCM edits survive refresh | PostgreSQL edit/reset/dedup/stale-revision tests; catalog browser flow; native test of corrected Pickering with displayed Chicago retained |
| 7: Tracked refresh/cancel | Catalog progress/partial-result tests; repository queue/cancellation tests; runtime interrupted-job tests |
| 8: Exact variant and pallets | Domain quantity/search tests and properties; actual browser exact variant and five-bundle job flow |
| 9 and D–E: Pickup and earliest native date | Native bound callback/calendar/blank-input/Order Summary fixtures; live Ayr October 16 check and date restoration |
| 10, A and F: Full cart quantity proof | Native positive/shortage/system-error/AJAX fixtures; exact increment/UOM/cart signature domain tests/properties; real cart increment |
| 11: Steps and protected screenshots | Router evidence authorization/path tests; runtime private image/error tests; actual browser blob-image assertions; saved live JPEGs |
| 12: Preserve cart; no checkout; serialize | Native restore/cancel/cleanup-failure/checkout fixtures; real PostgreSQL worker-lock test; live restoration steps |

## Final validation

All module measurements below were refreshed after the last implementation edit.
The two existing-suite runs compare the retained pre-change application with the
candidate shared wiring. They span the final native-adapter fixes; legacy source
and shared wiring were unchanged throughout. The final module runs cover those
adapter fixes separately.

- `STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final`:
  **{normal[0]} pass, {normal[1]} fail** (real PostgreSQL and Chromium).
- Same runner, stage `final-shuffled`: **{shuffled[0]} pass, {shuffled[1]} fail**;
  file order shuffled with seed 20261014 and saved in artifacts.
- Stage `property`: 6 properties with 150 generated cases each. Five plausible
  domain/vault mutants killed **5/5 by unit tests and 5/5 by properties alone**.
  Stage `runtime-mutant`: **4/4** additional worker/recovery/redaction mutants
  killed. Source hashes were unchanged after mutations. The lock mutant first
  triggered the queued-status assertion, then its blocked worker was killed at
  the 30-second child deadline; that timeout is recorded separately.
- Stage `static`: ESLint (including complexity 16/depth 5), check-JS TypeScript
  for domain/vault, and diff secret scanning completed with zero reported
  lint/type errors or high-confidence secret findings. Type coverage is limited
  to those modules; the rest is JavaScript with runtime/behavior tests.
- Node coverage: **{cov['lines']['covered']}/{cov['lines']['total']} lines
  ({cov['lines']['pct']}%)**, **{cov['branches']['covered']}/{cov['branches']['total']}
  branches ({cov['branches']['pct']}%)**. UI browser coverage:
  **{ui['executedLines']}/{ui['totalLines']} lines**, **{ui['executedBranches']}/{ui['totalBranches']}
  branches**. These are measured module totals, not 100% changed-line coverage.
  Serialized `page.evaluate` DOM/calendar functions execute in Chromium but are
  not instrumented as Node source. Browser DOM instrumentation and several
  defensive/error branches remain coverage gaps; no complete-coverage claim is
  made and no assertion was weakened to raise a score.
- Existing MBT regression runs: **{reg['filesPerRun']} files each**; baseline
  **{reg['baselineTestsReported']} reported tests / {reg['baselineFailedFiles']} failing files**,
  candidate **{reg['candidateTestsReported']} reported tests / {reg['candidateFailedFiles']} failing files**.
  The raw candidate run had **{len(reg['rawNewFailedFiles'])} extra timeout file**,
  with no named assertion failure. That unchanged scrolling fixture was repeated
  alone against both versions, keeping its assertions and 90-second deadline:
  **20/20 passed in each run**. Its seven tested public source files are byte
  identical. The shared-budget timing failure is classified separately, with
  the original failure retained. **0 unresolved new failing files and 0 new
  named failing cases.** Full failing names are
  retained verbatim in `regressions.json` and the baseline/candidate logs.
  Pre-existing browser timeouts are bounded at 90 seconds per file, so reported
  test counts omit files that never produced their test totals. This is the
  MBT suite; other standalone dispatch/PDF suites were not rerun.
- `bash server/tools/stock-check-audit.sh`: **0 new advisory IDs**. Existing
  production dependency findings remain: baseline
  {audit['before']['metadata']['vulnerabilities']['total']}, candidate
  {audit['candidate']['metadata']['vulnerabilities']['total']} affected package
  entries, including a pre-existing critical entry. The extra minimatch entry
  references an existing brace-expansion advisory, rather than a new advisory.
  Promoted pinned Playwright and playwright-core use Apache-2.0 licenses.
- Stage `boot-green`: exact final image started healthy with synthetic data;
  disposable app/database/network were removed afterward.

## Failures found and corrected

Behavioral RED logs record the original missing module behavior and later native
portal failures. The live date input was blank, `beforeShowDay` required its
input binding, Order Summary held the saved date, and Add to Cart completed in
a popup without navigation. Fixtures reproduced these before the fixes. The
SCM unknown-label correction also failed before its fix. Failed live attempts
remain visible for SCM review; the final pilot succeeded.

The first overlay image copied protected source files with incorrect ownership
and failed startup. The release automatically rolled back to the healthy original
image; `COPY --chown=node:node` and the isolated boot guard corrected it.
An early regression comparison was invalid because sudo dropped the source-root
environment variable. Those workspace-only logs were retained as diagnostics
and excluded. Both genuine runs now explicitly pass the source variable through
sudo and assert/save the resolved before/candidate mounts.

## Reproduction and limits

Run `bash server/tools/stock-check-gauntlet.sh` from the repository root, followed
by `python3 server/tools/stock-check-evidence.py`. The entry point runs module,
shuffle, static, property, mutation, dependency, build/boot and existing-regression
layers. It requires the retained captured source and pinned test image/toolchain
in this workspace, Docker, and the installed mbbs-tests.slice budget. A fresh
checkout needs those baseline/toolchain artifacts; this is not a standalone CI
bootstrap. No live vendor credentials are used in disposable tests.

Node {cleanup['nodeVersion']}; PostgreSQL 18 test image pinned by Compose digest. Recorded tool
versions: {', '.join(name+' '+version for name,version in versions.items())}.
Candidate manifest hash: `{source_hash}`. Published source hash (excludes
Dockerfile): `{published_hash}`. Changed paths are retained in
`evidence-summary.json`; unrelated captured production source is preserved.
No git commit or checkpoint cadence was requested.

Known limits: other vendor adapters and automatic fallback-location stock
attempts are not implemented yet. A conflicting existing cart pickup stops for
SCM review. Our workers are serialized globally; concurrent cart edits by a
person on the vendor website are outside that lock. A process crash cannot run
its finally cleanup, so interrupted jobs retain their baseline and require SCM
review. Live inventory results are timestamped observations and can change.

Host cleanup is registered before each test launch. Every isolated Compose
project is torn down with volumes/orphans removed; one-off containers use --rm.
Final Docker/container/network/volume and production-health evidence is saved
in `test-artifacts/stock-check/final-host-cleanup.json`. Production data,
operational screenshots/audits, and rollback images are retained.
"""
(server/'test/stock-check-evidence.md').write_text(text)
print(json.dumps({'report':'test/stock-check-evidence.md','sourceHash':source_hash,'tests':normal,'regressionNewFailures':0}))
