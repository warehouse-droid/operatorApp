# Local closure evidence

SPREQ-000011 is closed locally. Its standard parent request state is `cancelled`,
the closure journal is approved, and the existing confirmer is retained.
An independent verification confirmed the commercial lines and other Special
Item requests were unchanged. NetSuite writes: **0**. SOM06738 remains
**Pending Billing**; POB03960 remains **Closed**.

The general closure path now verifies already closed linked orders and completes
the request locally. Pending Billing is accepted only by the explicit recovery
option used for this user-authorized request, with fresh evidence that every
material quantity is fulfilled; ordinary HTTP contexts do not enable it.

Tier 3. **Spec approval: not obtained (autonomous run).** The user explicitly
authorized this request's local closure after its actual NetSuite state was
reported. The append-only [spec](special-local-closure-spec.md) records this
refinement. Confidence is limited to its stated behaviors.

| Spec behavior | Executable evidence |
|---|---|
| Exact remote IDs, references, types and closed statuses | Unit header contract and generated invalid/open/duplicate evidence tests |
| Sales and SCM local completion without NetSuite mutation | Unit service tests; real database Sales and confirmed-attention recovery tests |
| Preserve confirmation, financial lines, links and completed history | Database attention-journal and commercial-line preservation assertions |
| Reject reopened, partial, missing or wrong linked evidence | Header/finalization properties, repeated-verification property and transactional partial-update test |
| Retain revision, scope, reason, review, planning and pending-operation guards | Database guard tests; existing advisory-lock, concurrency and retry tests |
| Preserve the existing remote cancellation path | Existing workflow/operation closure suites; original assertions unchanged |
| Explicit fulfilled-SO recovery preserves actual Pending Billing status | Fulfillment property and opt-in database test; live recovery verification |

Tests are in [unit contracts](mbt/unit/special-local-closure.test.js),
[database contracts](mbt/integration/special-local-closure.test.js), and the
existing workflow/operation closure suites.

| Layer | Actual result |
|---|---|
| Related Special Item unit, property and integration suites | **481 tests: 472 passed; 9 reproduced baseline failures; 0 new failures** |
| Focused closure suites in reversed file order | **37/37 passed** |
| Changed executable lines | **156/156 covered** |
| Measured branches | **129/134 covered** |
| Manual mutation, contract suite | **3/3 killed**: accept every status, omit exact reference, omit second verification |
| Same mutants, property suite alone | **3/3 killed independently** |
| JavaScript type checking | New read-only verifier passed `tsc --checkJs --noEmit` |
| Scoped lint, syntax and diff secret scan | Passed; zero lint warnings |
| Real execution | Local recovery and separate read-only verification both succeeded |
| Deployment | Exactly three runtime files; both health endpoints returned 200; settings, worker, dependencies and schema unchanged |

The final related-suite execution used a frozen candidate and test snapshot.
After correcting comparison orchestration, the remaining constraints were
resumed using that run's saved coverage; runtime and behavioral assertions did
not change. The baseline comparison runs those same frozen failing test files
against the original captured closure code. The nine exact failure names are in
[summary.json](../test-artifacts/special-local-closure/summary.json); original-code
results are in [baseline-final.txt](../test-artifacts/special-local-closure/baseline-final.txt).
They concern currency display, concurrent name/brand work, PO approval/Dispatch
guards, legacy customer drafts and unrelated NetSuite configuration. No failing
assertions were weakened or skipped.

Reproduce the full isolated check from the server directory:

```sh
python3 tools/special-local-closure-check.py
```

This uses the existing isolated Node/PostgreSQL containers and their installed
tools. The persisted [runner](../tools/special-local-closure-check.mjs) contains
all type, lint, syntax, coverage, mutation, property, suite-order and secret-scan
commands. Versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0. No application dependencies or migrations were added.

Frozen source-manifest SHA256:
`6a0d2793706406e9d874d374de6dc57b2429f8227681aadea599c93764fa1009`.
The manifest identifies the tested snapshot before this final documentation
append. Candidate source, captured baseline, runtime diff and individual logs
are in [test artifacts](../test-artifacts/special-local-closure/summary.json).
The repository candidate excludes another session's unrelated name/brand edits;
their workspace edits remain intact. No commit or reset was made.

Deployed image:
`sha256:b73aaa64b54338f6f678b1fdef90ece2c4470cc9a3bdb9c2ad8a4752e7878226`.
Release evidence is in [deployment result](../deployments/special-local-closure-20260930/result.json).
A rejected public health check triggered a successful rollback before the
corrected check and final release. The earlier image-build failure and rollback
artifacts were retained. The private live checkpoint and result are stored with
restricted permissions under `test-artifacts/special-local-closure/live/`.

For an independent live saved-state check:

```sh
python3 tools/special-local-closure-000011.py verify
```

Limits and skipped layers: five measured optional/guard branches were not
executed; their locations are recorded in the coverage summary. Whole-repository
strict typing, unrelated non-Special Item suites and randomized ordering were
not run; the new verifier was type checked and focused suites ran in reverse
order. Complexity was reviewed manually without a numerical threshold. No
formatter is configured for this scoped check. Dependency audit and migration
rollback rehearsal were omitted because neither dependencies nor schema
changed. The malformed-evidence properties and transactional guard tests form
the adversarial pass. NetSuite and PostgreSQL do not share an atomic lock:
two fresh remote reads and a local advisory lock/revision check reduce, but
cannot eliminate, a remote change after the final read.
