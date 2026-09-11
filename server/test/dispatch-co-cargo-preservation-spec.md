# CO cargo preservation and targeted recovery — Tier 3

Spec approval: not obtained (autonomous run). User authorized the general fix,
the specific CO-GOA-7453-7455 repair, stress testing, seven-day replay, and
deployment only after tests pass. This artifact makes that scope executable.

## Failure model and acceptance criteria

1. Compact CO cards must not relabel source SO/TO children as COs. Hydration
   must replace incomplete source details with authoritative details.
2. One local CO for a grouped source is not an aggregate CO group. Cargo is
   owned by local_co_order_lines; missing/empty child details cannot erase it.
3. Full and incremental plan authority reconciliation must restore an empty
   unexecuted CO snapshot from its persisted cargo. A second pass is identical.
4. Real groups of local COs retain aggregation, cancellation and member identity.
5. Source SO/PO/TO quantities, fee-only orders and empty-pickup skipping remain
   unchanged. No artificial pickup for orders with genuinely no transport lines.
6. Completed/executed cargo and stop evidence must not be silently rewritten.
   No production history rewriting, bulk repair, NetSuite writes, or line deletion.
7. Repair only CO-GOA-7453-7455 in the current Sept 4 plan: restore its persisted
   product 559.68 / 6 pallets and PALLET quantity 6; ensure pickup 2967 before its
   existing delivery in Li Load 4; retain other orders, stops and assignments.
8. Recovery is dry-run first, backed up, atomic, revision-checked and idempotent.
   Changed revision, executed work or unexpected source lines block recovery.
9. Stress/property tests exercise repeated and shuffled partial/full refreshes,
   source types and child counts; concurrent/stale save tests prevent lost edits.
10. Capture seven elapsed days of production evidence read-only. Replay the
    affected cargo/normalization/validation paths offline; report coverage gaps
    rather than calling incomplete evidence a full historical pass. Deployment
    is blocked by failures or an unmet requested replay gate.

## Setup and verification

- Existing Node test runner, fast-check, c8, ESLint, TypeScript and Playwright.
- Temporary Docker Compose project with isolated network and tmpfs Postgres;
  no external application writes from tests. No new dependencies or git commits.
- Add focused frontend, integration, property/stress tests, persisted mutation,
  replay and recovery tooling, a gauntlet entry point and evidence report.
- Preserve the dirty worktree and keep the earlier PO-allocation draft out of
  the candidate release. Release is based on the currently deployed image.
- Run RED before implementation, relevant regression suites and the project
  full suite with baseline failures recorded, static checks, changed-line
  coverage, manual mutants, shuffled suite, realistic execution, source/diff
  and secret checks. Document non-applicable/unavailable layers explicitly.
- Deploy and perform the approved targeted repair only after the test/replay
  gate passes; retain rollback image and before-state backup.

## Visible clarification — historical replay fidelity

The seven-day run exposed capture limitations, not an absence of SCM activity:
SCM audit rows exist but are classified as Dispatch. Anonymization also discards
PO allocation quantities, manifest lines and charge/credit classifications.
The replay generator creates vendor-pickup SO cargo without vendor allocation.
Add failing fidelity tests before correcting this test tooling. Preserve all
acceptance assertions; regenerate the read-only capture and rerun. Do not count
manufactured pickup failures as application regressions or waive real failures.

## Visible clarification — release contracts and current-plan replay

The release must bump the exact Dispatch JavaScript cache key to
`20260905-co-cargo-preservation-v1`; update the exact asset-contract expectation,
not its specificity. Register the new dedicated mutation runner in the existing
exhaustive inventory and its exact inventory test. Both release-contract gaps
were observed in a full-suite run before these updates.

The current-plan replay also revealed empty CO-GOA-7941-7987 cargo. Its existing
five-pallet manifest must hydrate correctly. Running the existing frontend pickup
reconstruction on the captured plan must yield zero validation conflicts, one
new physical 2967 stop shared with CO-GOA-7453-7455, preserved existing stop IDs,
and unchanged unrelated loads. This adds no direct database repair of that CO.

Suite-health correction: Dispatch HTTP fixtures explicitly require the existing
per-file database clone runner. Reusing one database across repeat/randomized
files leaves edit leases behind and lets unrelated rollback fixtures contend
for global locks. Run ordered coverage and seeded shuffled health through the
repository's clone runner, keeping the actual simultaneous-dispatcher tests
and all their assertions intact. Do not weaken concurrency acceptance.

Adversarial cargo clarification: a local CO owns its physical manifest. Source
SO/PO `poAllocated*` metadata in a copied raw line is not a CO allocation and
must not make that manifest disappear from required-pickup calculations. Keep
the persisted quantities and other line detail, without those source-only fields.
