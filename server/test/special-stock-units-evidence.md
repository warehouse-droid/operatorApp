# SPREQ-000007 recovery — 2026-09-26

SPREQ-000007 (case 62) is linked to **SOB121380**, NetSuite ID **1017068**,
status **Sales Order : Pending Fulfillment**, with its attention flag cleared.
An authoritative REST read verified exactly:

| Item | Units ID | Quantity | Rate |
| --- | --- | --- | --- |
| MBBS-Special Order (2055) | 865 / PC | 500 | 17 |
| PALLET (1784) | 246 / EACH | 11 | 40 |

The exact `MBBS-SPECIAL-SO:62` marker returned one order. The full application
case fingerprint for SPREQ-000006 remained unchanged throughout recovery. No
purchase order was created. The user explicitly authorized retrying only
SPREQ-000007; SPREQ-000006 was never rearmed or submitted.

## Cause and delivered behavior

The adapter correctly resolved unit 865, but the payload serialized it as
`{"id":"865"}`. Live REST order records return scalar units such as `"866"`
and `"246"`. Payloads now send scalar units, and description/quantity verifiers
read scalar or reference-shaped units without dropping unit checks.

The first corrected submission exposed a second definitive validation error:
the pallet inventory line required its own location. Both SO and PO payloads
now assign the resolved order yard to every material and ancillary line. Each
issue received a failing regression before its implementation change.

Production received only the three special-order payload/adapter modules,
layered over the running image. App and worker settings were preserved; the
database and Ollama containers were unchanged. No migrations, dependencies,
Git commits or unrelated worktree edits were made by this task.

Final image: `mbbs-operator-app:special-stock-rest-units-20260926-v2`

Image ID: `sha256:8b6ce78a687293724fb690af7ef1d38cc21edebe1db73d314bb575502df04c45`

## Specification and evidence mapping

Spec approval: not obtained (autonomous run). See
[the append-only specification](special-stock-units-spec.md). This is Tier 3
evidence for the stated financial and duplicate-creation boundaries, not a
claim of completeness beyond them.

| Behavior / failure mode | Evidence |
| --- | --- |
| Correct scalar units; unchanged quantities, rates and identities | Concrete SPREQ fixture plus generated numeric/string unit IDs in `special-stock-rest-units.test.js`; live readback above |
| Description edits preserve units and detect external changes | Generated scalar/reference fixtures, pre-write unit conflict and post-write unrelated-unit corruption assertions |
| Quantity edits preserve prices, units and unrelated lines; replay is idempotent | Generated scalar/reference quantity plans and existing quantity adapter tests |
| Missing optional units on unrelated lines remain valid | Generated optional-field preservation test; mandatory-unit mutant killed |
| Every SO/PO line uses the resolved yard | Generated location IDs; omitted-location mutant killed; successful live creation |
| Unknown outcomes remain locked; markers prevent duplicate creation | Existing service tests for prior durable submissions and marker recovery, plus exact live marker count |
| Concurrent claims cannot overwrite another operation | Existing database close/create and revision race tests; administrative recovery additionally locks request/case rows and compares the exact revision, operation, error and draft hash |
| Only the authorized request can be recovered | Recovery command hardcodes case 62, SPREQ-000007, the observed operation/revision/error; SPREQ-000006 read-only fingerprint stayed identical |
| Deployment preserves unrelated code and configuration | Three-file Docker layer, previous-live source hashes, candidate smoke, runtime hashes, configuration digests, automatic rollback path and healthy application |

## Final verification

One entry point reruns the isolated checks:

```sh
bash server/tools/special-stock-units-check.sh
```

This uses the repository's existing `mbbs-special-review-runner` and
`mbbs-special-review-db` (`mbt_verify` only). It never runs tests against the
production database. Commands and mutation definitions are persisted in
`tools/special-stock-units-check.mjs`; no mutations are made to shared source.

| Layer | Actual final result |
| --- | --- |
| Complete special-workflow unit/property/integration suite | 158 tests: 157 passed, 1 unchanged baseline failure, 0 skipped; zero new failures |
| Focused payload, adapter and submission-lock suite | 44 passed, 0 failed, 0 skipped |
| Changed executable lines | 19/19 covered |
| Three runtime modules | 370/370 lines and statements; 22/22 functions; 234/252 branches (92.85%) |
| Mutation testing | 7/7 plausible mutants killed by the property suite alone |
| Suite health | Seeded shuffled file execution retained the same 157 passes and single baseline failure |
| Static checks | JSDoc/TypeScript for both adapters, syntax for the existing dynamic payload module, ESLint for the three runtime modules, new tests and retry/check scripts: passed |
| Additional operational checks | Deployment Python compilation, shell syntax and scoped `git diff --check`: passed |
| Secret scan | Passed for scoped runtime/test/check files; no dependency changes |
| Real execution | Candidate image smoke, live app health, successful SO creation, REST line readback, unique marker and unchanged protected request |

The pre-existing failure is:

```
Dispatch save and restore require a route and Via Yard receipt without weakening snapshots
error: function dispatch_direct_to_has_residual(bigint) does not exist
```

It was present before implementation (151/152 baseline passes). The existing
isolated database lacks that function from unrelated dispatch work. The
verification runner tolerates only this exact named failure and error; any new
failure fails the check. No test was disabled or weakened.

During verification, the initial four units tests failed against the original
implementation. The later location property separately failed before its fix.
The inherited coverage gate initially exposed missing tests for optional
fields; a meaningful preservation property and corresponding mutant closed
that gap. Node's `structuredClone` was explicitly declared for the existing
browser-oriented lint configuration. The first administrative rearm attempt
rolled back because JavaScript's millisecond timestamp omitted PostgreSQL's
microseconds; the command now uses the exact timestamp read under the row lock.
That aborted attempt sent no NetSuite order. Each actual rejected submission
retained its normal durable lock until a separately checked, audited recovery.

Known limits: no human pre-implementation spec review; full repository suites
outside special workflow were not run; the described pre-existing database
failure remains; payload code received syntax and executable contract checks
rather than new TypeScript annotations. UI, performance benchmarks, package
audit/license changes and migration rehearsal were not applicable because
those surfaces did not change. No claim is made that PO creation was exercised
against live NetSuite; its payload contract was tested locally.

## Reproducibility and receipts

Tool versions: Node v20.20.2, c8 12.0.0, TypeScript 7.0.2, ESLint 10.8.0,
fast-check 4.9.0.

Git base: `3de46cd5953ac57ded6833605060280e355aaa5f`; the workspace already had
unrelated uncommitted work. Exact tested file hashes are in
`test-artifacts/special-workflow-review/rest-units/source-manifest.json`
(SHA-256 `28425990b7731f97f3be8f6a2a25fe87f31586fef307b9963e2d869a8cd1df90`).
That directory also retains baseline/final test logs, coverage, shuffled runs,
mutation logs and tool versions.

`tools/special-stock-units-deploy.py prepare|apply|verify` preserves a rollback
image, image smoke and runtime/configuration checks. The final manifest and
receipt are under `test-artifacts/special-stock-units-release-20260926-v2/`.
Private case snapshots are mode 0600 inside the restricted release directory.

`tools/special-stock-units-retry.mjs` defaults to read-only preflight. Its
`--apply` mode was executed through the production container from `/app` only
after snapshot, definitive rejection, unit resolution and fresh marker checks.
It records an audit event before using the existing submission service and
verifies the result. Its fixed revision guard prevents rerunning it against
the now-successful request. Do not relax that guard to rerun this repair.
