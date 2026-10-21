# Sales split allocation blocker and unsplit: evidence

SOM06964 was repaired before this general change. Its five PO allocations were
cancelled and two splits retired through the operational services under testAdmin;
the original sales header and lines remained byte-equivalent under the recorded
canonical hash. Dispatch and Operator show the locally reopened original. See
[som06964-unsplit-repair.md](som06964-unsplit-repair.md) for audit and verification.

Spec: [split-allocation-unsplit-spec.md](split-allocation-unsplit-spec.md).
Spec approval: not obtained (autonomous run). Tier 3; lower confidence than an
independently approved specification. No dependencies or migrations were added.
No NetSuite writes were performed. No commits or resets were made in the shared
dirty repository. The release overlays exactly six runtime files from the tested
candidate; unrelated workspace edits are excluded.

Reproduce from the repository root:

```sh
bash server/tools/split-allocation-guard-20261015/gauntlet.sh
```

| Layer | Measured result |
| --- | --- |
| RED against captured live source | 12 failed, 2 passed / 14 |
| Existing relevant baseline | 149 passed, 0 failed / 149 |
| Final relevant suite | 163 passed, 0 failed / 163 |
| Reversed full file order | 163 passed, 0 failed / 163 |
| Changed executable lines | 88/88 covered |
| Manual mutants | 12/12 killed |
| Property-only rerun of all mutants | 3/12 killed; scope limits below |
| Types | 21353 baseline, 21351 candidate diagnostics; zero new |
| Lint and syntax | Zero new runtime or new-test diagnostics; all changed JavaScript parses |
| Real execution | Actual HTTP preview and stale-plan save reject with 409; actual PostgreSQL race passes |
| Cleanup | Task containers, volumes and networks removed; production health passes |

All final numbers follow the last runtime edit. The 14 new tests are in
`dispatch/integration/sales-split-allocation-unsplit.test.js`. The 149 existing
tests cover split/resplit/unsplit integration, HTTP and browser flows, PO split
targets, dependency guards, local reopen and fulfilled-order planning.

Specification mapping:

1. Allocation blockers: PO and TO preview/numbering cases; authoritative global
   persistence negative controls; changed existing quantities; real HTTP preview
   and stale direct plan PUT; all non-cancelled TO states and empty legacy PO
   targets; real PostgreSQL lock contention where a committed PO link wins.
2. Valid workflows: cancelled PO/TO links permit splitting; unchanged allocated
   children permit normal saves; existing completed-sibling/resplit regressions
   conserve sibling history. These two initially passing new regression cases
   are validated by the cancelled-link and sales-conservation mutants.
3. Unsplit integrity: legacy non-inventory sales-only metadata restoration;
   fixed-seed fast-check partitions (12 generated cases); converted packing and
   actual sales shortages reject atomically; unknown child lines reject. Existing
   resplit/unsplit suites cover roles, edit leases, activity, lineage and rollback.
4. Reopened billed state: actual immutable reopen audit followed by unsplit returns
   local-open/planning flags while NetSuite remains G. Existing refresh, stale-save
   and retired-child regressions cover visibility after restoration. The separate
   read-only SOM06964 check confirms the actual operational state.

The hostile-input pass includes unknown child lines, malformed allocation target
fallbacks, non-cancelled dependency statuses, modified existing definitions and
direct stale saves. Guards reject before partial split materialization. Every
manual mutant is run in an isolated temporary source copy, removed in finally.
The 12 selected bugs cover missing PO/TO checks, overblocking cancelled links,
bypassed persistence, missing fleet lock, legacy metadata rejection, ignored sales
conservation, discarded unknown lines, stale local flags, lost descriptive pieces,
HTTP recovery acknowledgement and floating-point identity errors.

The property alone kills the three quantity-related mutants (legacy rejection,
lost restored pieces and false stale decimal quantities). Its nine surviving
mutants concern allocation, HTTP, concurrency, invalid-child and local-authority
behavior that the valid-partition invariant does not express. Those are killed
by the scenario suite. This is an explicit property scope limit, not a claim that
the properties independently verify the entire implementation.

Failures found and corrected: the RED fixture initially omitted a required PO
line key and used null for a non-null legacy target; the fixture was corrected
without changing behavioral assertions and RED rerun. GREEN exposed 202 recovery
acknowledgements for blocked saves and binary floating-point tails producing false
stale conflicts. Runtime now returns 409 for allocation conflicts and uses the
application's existing six-decimal materialization precision for identity checks.
Actual quantity-conservation tolerances were not changed. Final static checking
found one missing parameter type; explicit JSDoc corrected it. No assertion was
weakened, skipped or removed. An initial repeat run encountered leftover test
accounts and edit leases. A clone attempt correctly hit legacy fixtures' exact-database-name safety
assertions. Those assertions are retained: the runner now recreates only the
strictly validated disposable mbt_test database from a pristine template between
phases and individual reverse-order files. Each mutant invocation has its own
disposable clone through the repository's existing helper. This also
ensures the recovery-code mutant fails at the intended HTTP assertion rather than
a leftover lease. Node sorts multiple CLI files, so reverse order is now executed
explicitly, one file per process. Failed-run logs are preserved. The append-only
spec records discovered behaviors.

Runtime adds local parameterized SQL checks and uses the existing transaction and
fleet lock; it introduces no network, subprocess, file or secret access. The full
six-file diff was reviewed for scope and secrets. The new helpers have individual
purposes (allocation guard, quantity identity, legacy conservation). Supply-chain
audit is inapplicable because no dependency changed. Frontend assets are unchanged:
the existing preview-error flow displays the blocker and disables confirmation.

Limits: unrelated application suites were not run. Selected manual mutations and
12 generated partitions are not exhaustive. Changed-line coverage is complete;
branch coverage is collected by c8 but no full-branch guarantee is claimed.
The application retains its recorded pre-existing type errors. No dedicated
performance benchmark or deployment failure injection was run; release checks
retain the previous image and automatically restore it if verification fails.

Runtime-manifest SHA-256: `dc587697125378bdf762a7a782b11d29b7c63fd452aa6b787eaee778e8e2920d`. Per-file source/test hashes and pinned
tool versions are in `test-artifacts/split-allocation-guard-20261015/summary.json`.
Source baseline and candidate are retained under `tools/split-allocation-guard-20261015`.
The candidate server preserves the exact live source plus the single recovery-code
addition; unrelated workspace import/comment edits are not deployed.

All tests use standard bounded Compose in `mbbs-tests.slice`, with init, matching
memory/swap limits, bounded CPUs/PIDs/tmpfs and disposable labels. Teardown is
registered before startup. Both running and stopped container listings, volume
and network checks, and production health are retained. Production credentials
and data were not mounted into tests. Operational audit and rollback artifacts
are preserved separately from disposable tests.

Tools: {"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "playwright": "1.62.1", "typescript": "7.0.2"}; Node v20.20.2.
Detailed logs and JSON are in `test-artifacts/split-allocation-guard-20261015`.
Release and rollback records are in `deployments/split-allocation-guard-20261015`.

## Live verification

Image `sha256:af2b86ceb06001655e0e0ec986f92f6653e0fd48ed2cdb411afcf58244efa788` deployed at 2026-10-15T15:29:43.902343+00:00. Only the app
container changed; service configuration, database, worker and Ollama are preserved.
Runtime file hashes match the final verified candidate. Read-only checks confirm
existing linked orders are blocked for PO, TO.
SOM06964 has 0 active PO allocations and
0 active splits; retired children are hidden. The original
is locally open, eligible for Dispatch planning and visible in Operator. NetSuite
remains `Sales Order : Billed`. Health passes and final host listings are
recorded in `deployment-result.json`.
