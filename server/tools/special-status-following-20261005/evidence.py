"""Write the evidence report from measured results for the deployed source."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-status-following-20261005'


def read(name):
    return json.loads((OUT / name).read_text())


unit, db, coverage, browser, lint = [read(name) for name in ['summary.json', 'db-summary.json',
    'changed-line-coverage.json', 'browser-summary.json', 'lint-delta.json']]
live, preview, applied, cleanup = [read(name) for name in ['live-verify.json', 'live-preview.json', 'live-apply.json', 'cleanup.json']]
assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == value for name, value in unit['manifest'].items())
assert coverage['allExecuted'] and live['businessUnchanged'] and applied['refresh']['updated'] == 2 and preview['rollbackRehearsed']
branch_total = sum(value['branches']['total'] for value in coverage['sources'].values())
branch_covered = sum(value['branches']['covered'] for value in coverage['sources'].values())
source_hash = hashlib.sha256(json.dumps(unit['manifest'], sort_keys=True).encode()).hexdigest()
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
failures = '\n'.join('- ' + name for name in unit['baselineFailures'])
mapping = [
    ('Physical pickup, yard arrival, delivery and actual Toronto timestamps; partial receipt and customer/vendor pickup remain accurate',
     'special-logistics-progress.test.js; SPREQ-000024 rendering scenarios; four authenticated Chromium checks'),
    ('Canonical native SO/PO status overrides old snapshots without confusing physical completion',
     'canonical projection/approval tests; actual PostgreSQL projection and authenticated endpoint checks'),
    ('Five-minute cache, batching, deduplication, exact identity validation, explicit refresh and failure isolation',
     'cache boundary tests; six seeded properties; real list/detail and force-refresh HTTP checks'),
    ('Webhook/concurrent refresh fencing, microsecond preservation, header-only writes and atomic audit/mirror rollback',
     'seven new PostgreSQL tests including concurrent refresh, intervening webhook, audit rejection and whole business JSON comparison; live rollback and business fingerprint checks'),
    ('Authenticated and scoped reads; active/visible/unedited polling; unchanged preview permissions',
     'existing authenticated HTTP regressions; polling and queue tests; Sales/SCM desktop and phone browser checks'),
    ('SPREQ-000024 repair and retained request, case/order lines, canonical lines, links, quantities, prices and completion evidence',
     'live-preview.json, live-apply.json and live-verify.json; recorded source hashes and production health'),
]
table = '\n'.join('| ' + behavior + ' | ' + checks + ' |' for behavior, checks in mapping)
text = f'''# Special Request status and completion time evidence

Spec approval: not obtained (autonomous run). The implementation follows the user's physical-progress and actual-completion-time clarification. Confidence is limited to the acceptance criteria in `test/special-status-following-spec.md` and its append-only revisions.

The app was deployed and SPREQ-000024 verified. SO: {live['salesDisplay']['SO']}. PO: {live['salesDisplay']['PO']}. Request revision remains {live['revision']}. NetSuite writes: {live['netSuiteWrites']}. Local header observations updated: {applied['refresh']['updated']}. The production rollback rehearsal restored the header cache; the business fingerprint stayed `{live['businessFingerprint']}` in preview, application and final verification.

## Reproduction and source

From `server/`, run `python3 tools/special-status-following-20261005/run.py final`. This runs the relevant Special unit regressions, baseline RED checks, syntax, type/lint deltas, manual and property-only mutation checks, suite order repeat, secret scan, real PostgreSQL/API checks, Chromium pages and changed-line coverage. It then checks resource cleanup. Test containers are offline/internal, disposable, initialized, labeled, and bounded in `mbbs-tests.slice`; they use fake test credentials and no production volumes.

Deploy commands are `python3 tools/special-status-following-20261005/deploy.py prepare`, `.../deploy.py apply`, and `.../deploy.py verify`. Deployment preserves the live environment and other production containers, checks source hashes, retains the parent image and automatically rolls back the app image on failed verification. Only eight runtime files were overlaid; no database schema migration was deployed.

Git base: `{commit}`. The workspace already had unrelated changes; no commits, resets or reverts were made. Source-manifest SHA-256: `{source_hash}`. Individual file hashes are in `summary.json`; deployed image is `{live['image']}`. Existing cached tool versions: {json.dumps(unit['tools'], sort_keys=True)}. Node 20.20.2; Chromium {browser['version']}; PostgreSQL 18. Cached image IDs are pinned in the entry-point scripts.

## Measured results

- Final Special unit regressions: {unit['regressions']['pass']}/{unit['regressions']['tests']} passed, with {unit['regressions']['fail']} unchanged baseline failures and zero new failures. Baseline: {unit['baseline']['pass']}/{unit['baseline']['tests']} passed.
- Focused status checks: {unit['focused']['pass']}/{unit['focused']['tests']} passed. Baseline RED: {unit['red']['fail']} failed and {unit['red']['pass']} passed. The three passing negative invariants are preservation checks killed by the corresponding fresh-cache and foreign-reference mutants. The discovered partial-receipt priority bug also failed before its correction (`red-partial-arrival.log`).
- PostgreSQL/API checks: {db['pass']}/{db['tests']} passed, including seven new integration checks. All seven failed against the baseline implementation (`red-db.log`).
- Browser checks: {len(browser['checks'])}/4 passed (Sales/SCM, 1440/390 widths); zero page errors. Actual `<time>` instants and displayed dates were asserted, as were SO/PO identities and preview permissions. Screenshots were retained and the Sales phone display was visually inspected.
- Changed instrumented lines: {coverage['executed']}/{coverage['changedInstrumentedLines']} executed across unit, PostgreSQL and converted browser V8 coverage. Branch outcomes touching changed ranges: {branch_covered}/{branch_total}; this is not a claim of exhaustive branch coverage. Details and uncovered branches remain in the coverage artifacts.
- Manual mutations: {len(unit['mutations'])}/5 killed by the focused suite, and 5/5 killed by the property suite alone. Six properties ran 100 examples each with recorded seeds 20261005–20261010.
- Type diagnostics: {unit['types']['baseline']} baseline, {unit['types']['patched']} patched, zero new. Lint diagnostics: {lint['baseline']} baseline, {lint['patched']} patched, zero new. JavaScript syntax checks and Python compilation passed. There is no task-specific formatter configured; the existing lint/style setup was used.
- Suite health: reversed file order repeated {unit['suiteHealth']['tests']} checks with the same four baseline failures. Secret scan passed. No dependencies or lockfiles were changed by this task; dependency audit/license checks were skipped because the dependency set was unchanged.
- Cleanup: {cleanup['retainedOwnContainers']} retained task test containers, {cleanup['retainedOwnTestNetworks']} retained task test networks; test PostgreSQL storage was tmpfs. Production health: {cleanup['productionHealth']}.

## Spec mapping

| Acceptance criterion / invariant | Evidence |
| --- | --- |
{table}

## Baseline failures retained

{failures}

These unrelated failures were reproduced before the change and remained unchanged. Existing untyped code also produces the recorded type/lint diagnostics; this task did not expand that debt.

## Review and limits

New runtime helpers each handle one concern: projection, cache selection/validation, guarded persistence, driver evidence, physical-state rendering or timestamp formatting. Status persistence changes only the two native header status fields and their cache/change timestamps, with atomic mirror and audit records. Local completion, references, prices and lines are read without mutation. Existing authentication and scope checks precede the added NetSuite read.

The adversarial review included missing, malformed, duplicate and foreign native identities, hostile labels, failed remote/persistence boundaries, concurrent writes, unfinished/foreign-kind driver records, partial receipt after a completed dropoff and missing/invalid timestamps. Missing evidence keeps the previous planning display; unknown completion times are never inferred from ETA, sync time or now. Native refresh depends on existing exact linked headers and direct NetSuite access, and runs at five-minute cache freshness while physical state can update via events or the visible queue's one-minute fallback. A NetSuite outage can delay the read until the existing transport timeout; retained cached state is returned after failure.

The harness required corrections for its legacy login selector/default tab assumptions, isolated database name and schema-reset lock slots, and current Playwright V8 coverage shape/CommonJS conversion import. Those checks were rerun. The partial-receipt bug was corrected after observing its new regression fail, and all final measurements identify the source after that correction. A superseded coverage run was correctly rejected by the source-hash freshness guard.
'''
(OUT / 'EVIDENCE.md').write_text(text)
print(json.dumps({'evidence': str(OUT / 'EVIDENCE.md'), 'sourceManifestHash': source_hash}))
