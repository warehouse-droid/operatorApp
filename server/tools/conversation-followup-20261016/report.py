"""Summarize the final saved candidate checks and production verification."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/conversation-followup-20261016'
summary=json.loads((OUT/'summary.json').read_text())
coverage=json.loads((OUT/'changed-coverage.json').read_text())
cleanup=json.loads((OUT/'release-cleanup.json').read_text())
manifest=json.loads((OUT/'source-manifest.json').read_text())
release=json.loads((ROOT/'deployments/conversation-followup-20261016/manifest.json').read_text())
deployment=json.loads((OUT/'deployment-result.json').read_text())
smoke=json.loads((OUT/'production-smoke.json').read_text())
assert summary['newFailures']==0
assert cleanup['productionHealthy'] and not any(cleanup[k] for k in ['ownContainers','networks','volumes'])
for name,digest in release['after'].items():assert manifest[name]==digest
covered=sum(entry['covered'] for entry in coverage.values());total=sum(entry['total'] for entry in coverage.values())
rows='\n'.join(f"| {name} | {entry['covered']}/{entry['total']} | {', '.join(map(str,entry['missed'])) or '—'} |" for name,entry in coverage.items())
text=f'''# Conversation follow-up — verification evidence

Spec approval: not obtained (autonomous run). Specification: `tools/conversation-followup-20261016/SPEC.md`. Tier 3 because authorization changes require positive and negative access tests. No new dependencies, migrations, live messages or live closure actions.

Final candidate results: {summary['tests']} tests, {summary['passed']} passed, {summary['failures']} known baseline failure, {summary['newFailures']} new failures. {summary['mutantsKilled']} deliberately broken implementations were rejected. Changed executable-line coverage: {covered}/{total}. Results refer to the exact captured candidate and the test/tool hashes in `source-manifest.json` (SHA-256 `{hashlib.sha256((OUT/'source-manifest.json').read_bytes()).hexdigest()}`).

Behavior mapping:

- SCM and admin accounts without Sales yards read, send and acknowledge Special and Backorder messages at all four supported yards: real HTTP integration cases. Sales wrong-yard reads/sends remain denied; feature flags, role checks and closed read-only rules remain covered.
- Empty history: full Chromium page test asserts no loading label while pending, then the empty state, then a successful first message.
- Message priority: four request types through both queue repositories, limit/offset and Backorder status filtering; old retry and automatic audit events do not change priority. Stocking Purchase uses the same Stocking path and has its own browser cases.
- Live ordering: ten browser cases (Sales/SCM × Special, Backorder, Stocking Transfer, Stocking Purchase, Delivery) verify moving cards, stale event rejection, sending, off-page requests, unchanged filters, reload ordering, and draft/focus/selected-detail preservation.
- Refresh races and failure: a failed list fetch preserves the list and draft; two arrivals while a fetch is pending result in a follow-up fetch and retain both requests.
- Existing behavior: typed-only/private-event history, notifications, legacy pending-information replies, concurrent/idempotent messages, unchanged request revisions/timestamps and related workflow regressions remain covered.

RED evidence: `red-service.log` contains the reported 403 and four ordering failures. `red-browser.log` contains the stuck empty label and ten failed live-order assertions. The initial service setup used an obsolete scm_staff role alias; corrected to valid SCM/admin accounts before implementation, as documented in the append-only spec. The first GREEN run caught a local variable shadowing the SCM Special list renderer; implementation was fixed without weakening assertions.

Mutation evidence: SCM yard check accidentally restored; empty label regressed; sort direction inverted; arrival during fetch dropped; SQL message ordering removed. The corresponding API, browser, ordering-property or pagination tests rejected each. Ordering properties exercise 250 generated scenarios and independently reject the reversed-sort mutant. Properties cover ordering and stale snapshots; auth/UI/database mutations rely on their API/browser/integration scenarios, not those pure ordering properties.

Static checks: TypeScript checks the existing message domain, ESLint checks conversation modules/tests/check runner, JavaScript syntax checks all changed runtime scripts, and the diff secret scanner passes. Broader legacy modules are not fully type-checked. No dependency set changed, so supply-chain installation/audit was unnecessary. Reverse-order unit-suite execution passed. Real execution includes the application HTTP routes against isolated PostgreSQL and complete Sales/SCM pages in Chromium with network fixtures.

The known unrelated baseline failure is `special-stock-updates.test.js:80`: Low inventory expects dispatch_arrangement but returns confirmed. `baseline-special-information.log` was preserved from the prior independent unchanged-live-source run. The final candidate reproduces exactly 2 passes / 1 failure for that suite; no assertion is weakened or skipped. This stage mismatch is not fixed here.

| File | Changed lines executed | Missed lines |
| --- | --- | --- |
{rows}

Coverage combines c8 server and real Chromium coverage. Branch details remain in the raw reports; exhaustive network/browser-platform branch coverage is not claimed. Complexity review: activity ordering, queue acceptance, refresh coalescing and event dispatch are separate small functions; queue SQL reuses the existing partial message index and sorts before pagination.

Reproduce: `python3 tools/conversation-followup-20261016/run.py release`. This mounts `tools/conversation-followup-20261016/candidate-runtime` read-only and runs `check.mjs`. Toolchain reused from the existing recorded installation: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright and Chromium from the configured test image. Source, tests, mutation procedure, commands and rollback artifacts are retained; disposable databases are not.

Deployment: `{deployment['image']}` at `{deployment['at']}`. Thirteen scoped files applied over captured live source; unrelated workspace changes were excluded. Application configuration and database/worker/Ollama containers were preserved. No database migration. Read-only production probes passed ({len(smoke['checks'])} checks); authenticated live business actions were deliberately not used as tests.

Host policy: all test containers use mbbs-tests.slice, bounded memory/CPU/PIDs/tmpfs, init and disposable labels. Teardown was registered before starting; successful and failed runs removed containers, volumes and networks. Both docker ps and docker ps -a were inspected and production health passed. Runtime artifacts confirm zero own test containers/networks/volumes remain.
'''
(OUT/'EVIDENCE.md').write_text(text)
print(json.dumps({'tests':summary,'changedLines':f'{covered}/{total}','cleanup':'verified','deployment':deployment['image']}))
