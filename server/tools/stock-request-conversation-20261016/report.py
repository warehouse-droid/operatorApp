"""Summarize fresh verification artifacts without rerunning or retaining test databases."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/stock-request-conversation-20261016'
summary=json.loads((OUT/'summary.json').read_text())
coverage=json.loads((OUT/'changed-coverage.json').read_text())
cleanup=json.loads((OUT/'release-cleanup.json').read_text())
manifest=json.loads((OUT/'source-manifest.json').read_text())
release=json.loads((ROOT/'deployments/stock-request-conversation-20261016/manifest.json').read_text())
assert summary['newFailures']==0
assert cleanup['productionHealthy'] and not any(cleanup[key] for key in ['ownContainers','networks','volumes'])
for name,digest in release['after'].items():assert manifest[name]==digest
covered=sum(entry['covered'] for entry in coverage.values());total=sum(entry['total'] for entry in coverage.values())
rows='\n'.join(f"| {name} | {entry['covered']}/{entry['total']} | {', '.join(map(str,entry['missed'])) or '—'} |" for name,entry in coverage.items())
text=f'''# Stock request conversations — verification evidence

Spec approval: not obtained (autonomous run). The user authorized conversations replacing Ask Sales for Special, Regular Backorder, Stocking and Delivery, and then explicitly requested notifications. See `test/stock-request-conversation-20261016-spec.md` (including the additive read-receipt migration revision). Tier 3: authenticated shared data, idempotency and notification concurrency.

Exact release candidate: base image `{release['app']['imageId']}` plus the 18 scoped file hashes in `source-manifest.json`. Manifest digest: `{hashlib.sha256((OUT/'source-manifest.json').read_bytes()).hexdigest()}`. Independent live imports were preserved when merging `src/server.js`.

Results from the final fresh candidate run: {summary['tests']} tests; {summary['passed']} passed; {summary['failures']} pre-existing failure; {summary['newFailures']} new failures. All conversation unit, database, HTTP and browser tests passed. Three deliberately broken implementations were rejected by the unit suite, and each was also rejected by the property tests alone. Reverse-order unit-suite repeat passed.

The pre-existing failure is `special-stock-updates.test.js:80`: Low inventory expects `dispatch_arrangement` but returns `confirmed`. `baseline-special-information.log` reproduces exactly the same 2 passes / 1 failure on unchanged live source. Candidate testing enforces that exact baseline result; no assertion was changed or skipped. This unrelated stock-stage test remains unresolved.

Behavior mapping:

- Both Sales and SCM on Special, Backorder, Stocking Transfer, Stocking Purchase and Delivery: ten full-page browser cases plus four real-database request-type cases.
- User-only history, no private or automatic events: explicit event-field allowlist unit tests, adversarial arbitrary-audit and private-audience properties, and legacy-history database checks.
- Retried/concurrent sends: five parallel identical operations produce one message; changed text with the same operation is rejected; distinct operations survive.
- Legacy pending-information and Stocking reply markers: real-database state assertions, preserving order/approval decisions. Browser regression proves SCM refresh remains available after a send.
- Unread alerts: recipient-only and yard scope, individual users, out-of-order read receipts, a new message arriving after the displayed one, badge/toast/link and read-on-display browser checks.
- Drafts and hostile input: failed retry retains text and operation ID; refresh and request switching retain drafts; HTML remains literal text. No live messages or order operations were used for validation.

Static checks: TypeScript checks the isolated message domain; ESLint checks every new runtime module and all conversation tests; JavaScript syntax checks cover every modified runtime script. Broader legacy modules are not newly type-checked. No dependency set changed; no supply-chain installation was needed. Existing diff-secret scan passed.

Changed executable-line coverage combines c8 server coverage and real Chromium coverage: {covered}/{total}. Branch coverage is recorded in the raw reports; not all defensive/network/browser-platform branches are exercised.

| File | Executed changed lines | Uncovered lines |
| --- | --- | --- |
{rows}

Reproduce from the saved candidate with `python3 tools/stock-request-conversation-20261016/run.py release`. The pinned existing test image, standard isolated Compose settings, source mounts, tooling versions and database setup are defined in `run.py` and `check.mjs`. Reproduce the independent baseline with `run.py baseline`; the captured baseline runtime is retained as source evidence, not a test database. Runtime source is read-only during tests. Mutants exist only in a temporary directory and are removed in finally.

Toolchain: Node 20.20.2; TypeScript 7.0.2; ESLint 10.8.0; c8 12.0.0; fast-check 4.9.0; Playwright from the recorded existing toolchain and browser image. No tools were installed into production.

Host cleanup: all test services used mbbs-tests.slice with bounded memory, CPU, PIDs and tmpfs, init and disposable labels. Finally teardown removed containers, volumes and networks, including failed runs. Both docker ps and docker ps -a were checked; only production containers remained and production health passed. Source, logs and rollback artifacts were retained. The read-receipt migration is additive; the prior application can run with it in place if rollback is required.
'''
(OUT/'EVIDENCE.md').write_text(text)
print(json.dumps({'tests':summary,'changedLines':f'{covered}/{total}','cleanup':'verified'}))
