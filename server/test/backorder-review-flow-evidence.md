# Backorder review flow — deployed evidence

Deployed at 2026-10-22T23:47:30.891336+00:00. Image `mbbs-operator-app:backorder-review-flow-20261022`,
`sha256:3af6a575a3ea1374c4a150f8180eb4fd3c47d2b4a0e02b5d711f2d59ffff1d15`. The live app is healthy, with unchanged runtime configuration
and unchanged database, worker, and Ollama containers. All 1447
source runtime files matched the candidate; only the seven scoped paths changed
from the prior SCM/dispatch/pickup release. Both STREQ-000165 and STREQ-000186
were checked in a read-only transaction and allow optional SO attachment.

Detailed spec approval: **not obtained (autonomous run)**. Tier 3 was selected
for the save boundary and revision concurrency. See [the specification](backorder-review-flow-spec.md).

## Final verification

| Layer | Result |
| --- | --- |
| New UI/API/property checks | 12/12 passed, no skips or cancellations |
| Existing affected-area regressions | 79/97 passed; 18 pre-existing failures, zero new or changed failure signatures |
| Baseline | 97 tests: 78 passed, 19 failed, captured before implementation |
| Changed-line coverage | 61/61 V8-mapped changed lines covered across policy, UI, and service |
| New shared policy branches | 18/18 covered |
| Deliberate defects | 5/5 caught by the unit suite and 5/5 caught by properties alone |
| Seeded properties | 400 attachment cases, 100 saved-editor cases, 300 terminal-state cases |
| Suite health | All 12 new checks passed again in shuffled file order: API, unit, browser |
| Static checks | New shared policy type check passed; syntax checked for 10 JS files; zero new scoped ESLint findings; zero secret findings |
| Browser execution | Chromium at 390×900 and 1280×900; real saves, reloads, keyboard Edit, and failed-save recovery |

The regression baseline and final failures are retained verbatim in
[baseline signatures](backorder-review-flow-baseline-errors.json) and
[final results](backorder-review-flow-evidence.json). The existing SCM vendor/review
browser case passed after adapting its interactions to Edit; this is not claimed
as a separate application fix. The other 18 baseline failures remain unresolved.

## Acceptance evidence

- Optional SO after persisted SCM replies, including pending Sales decisions:
  unit generated eligibility, API save snapshot, and mobile browser save/reload.
- Saved quote, stage, quantities, decisions, and formal SO/PO links stay intact:
  API before/after snapshot; canonical reference conflicts also remain protected
  by the existing arrival-integrity tests.
- Role, yard, forged review fields, invalid references, closed cases, and stale
  revision attacks: API adversarial cases. Two concurrent saves yield exactly
  one success and one 409, with one audit event.
- Saved Sales and SCM forms collapse; pending/reset forms remain visible:
  generated editor properties plus both browser Edit flows. Values are restored,
  only the selected material opens, success collapses, and a failed save keeps
  entered values. Keyboard access and aria-expanded are asserted.
- Editor state across unrelated render calls: code review of the retained
  request/material-keyed Set; no separate browser acceptance case for this edge.
- Earlier Already Ordered behavior, receipts, PO recheck, terminal protection,
  and manual order linking: existing affected-area regression suite.
- Asset freshness: versioned Sales/SCM entry points and live HTTP byte hashes.

## Corrections and limits

The RED run observed eight new-behavior failures before implementation; two
existing protections passed immediately. Additional generated cases were then
validated by the deliberate defects. An implicit-any annotation was corrected.
Browser setup now closes real notification popups through their Close button.
An expected heading was corrected to the existing “Awaiting Sales confirmation”
text. Existing tests that attempted direct edits of saved forms now open Edit;
their PO/revision/decision assertions remain intact. Old quote-only expectations
after SCM review were changed to the requested optional SO behavior.

Coverage initially missed Edit handlers after browser reloads. The recorder now
captures before navigation and binds ranges to actual successful JavaScript
responses; source bytes are checked before coverage is merged. Redirect bodies
are excluded. No runtime code was altered to improve the coverage result.

Type checking covers the new shared policy. Modified legacy UI/service code is
covered by scoped syntax/lint and execution, not a new whole-repository type
baseline. The repository-wide suite was not run; this validation targets the
Backorder/Already Ordered boundaries touched by the change. Browser coverage is
Chromium only. No dependencies, migrations, or manual production-data repairs
were introduced. The dependency lock and dependency versions match the release;
workspace package scripts differ from the deployed package scripts.

## Reproduction and cleanup

From the repository root, using the captured release and normal Docker access:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 docker/retention/retention.py run -- python3 server/tools/backorder-review-flow-release.py validate-image
```

The JSON report records the exact seven source hashes and tool versions:
Node v20.20.2, Playwright 1.62.1,
TypeScript 7.0.2, ESLint 10.8.0,
fast-check 4.9.0, c8 12.0.0.
The release manifest identifies the full runtime tree and base image.

Every run used bounded disposable containers in mbbs-tests.slice. Teardown was
registered before startup, Compose resources were removed with volumes and
orphans, and the retention runner removed raw coverage, browser output, logs,
and temporary runtime copies on both success and failure. Both docker ps and
docker ps -a were checked. Independent disposable projects on this shared host
were left to their owning runs. None remained at the deployment audit; another
source-save project started before the final health check. No Backorder review
containers, volumes, networks, test images, or artifact directories remained.
Production and rollback resources and operational deployment records were retained.

Rollback image: `mbbs-operator-app:backorder-review-flow-20261022-rollback`.
