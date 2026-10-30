# Delivery to pickup release evidence — 2026-10-22

Spec: [delivery-pickup-release-spec.md](delivery-pickup-release-spec.md), Tier 3.
Spec approval: not obtained (autonomous run). The user subsequently explicitly
authorized deployment of this automatic release update. The future-transition
rule was installed on 2026-10-22 at 20:42 UTC with the SCM and SOA10414 updates.
The compiled live function and trigger match the rule exercised by the 125/125
passing combined regression tests. See
[combined deployment evidence](scm-cargo-pickup-20261022-evidence.md).

Reproduce the final validation with:

```sh
bash server/tools/delivery-pickup-release-checks.sh
```

The runner uses the repository's isolated Compose configuration, mbbs-tests.slice,
bounded containers, unique retention-managed artifacts, and unconditional removal
of containers, volumes, networks, and generated logs. Final host checks showed only
the four production containers in both docker ps and docker ps -a; health returned
ok. No disposable volumes or networks remained for the final project.

| Layer | Final observed result |
| --- | --- |
| New acceptance tests plus existing pickup yard, pickup photo gate, and grouped packing suites | 36 passed, 0 failed, 0 skipped |
| Restored acceptance suite after mutation | 10 passed, 0 failed |
| ESLint on new tests and gauntlet | 0 errors/warnings |
| PostgreSQL migration/type validation | Migration applied in disposable PostgreSQL 18; actual trigger exercised through sync and Dispatch repositories |
| Properties | 25 generated source/loaded quantity examples, seed 10368 |
| Manual mutations | 5/5 killed: retained sales packing, erased loaded quantity, repeated-pickup release, skipped quantity lock, retained packed status |
| Property-only mutation check | Both quantity mutants killed; no claim that quantity properties cover locking or status |
| Concurrency | Second database connection holding the real Operator advisory lock prevents the method change with SQLSTATE 40001; retry succeeds |
| Repair rehearsal | Stale pickup header repaired; new packed work rejected; rehearsal rolled back |
| Sync harness baseline | Same existing failure with trigger absent and present: `Receiving did not use the fixed PO receipt baseline.` Same two preceding checks passed; 0 new failures |

Acceptance mapping: criteria 1–8 map to the ten named tests in
`test/mbt/integration/delivery-pickup-release.test.js`. Criterion 9 maps to
`repairRehearsal` in the gauntlet and the refused live repair described below.
The negative method-transition test passed before implementation; broadening the
trigger condition made it fail in the final mutation run. The other nine
acceptance tests were observed failing before implementation.

Limits: the whole repository suite was not run; validation covered the affected
packing/pickup suites. Formal PL/pgSQL line/branch coverage was not measured
(V8/c8 cannot instrument the database function). There is no new application JS
requiring TypeScript checks. Suite ordering was fixed; repeat and restoration
runs were deterministic. No dependencies were added; dependency/license audit
was therefore not rerun. This feature changes no UI assets or external APIs.
The combined deployment verified rule installation without changing a live
order's delivery method to exercise it.

Source SHA-256 values emitted by the final fresh gauntlet:

- Migration: `a7389af2f2b9049619904fb6ca4f8862b6733ba4187f368597e5ccc018e05145`
- Acceptance tests: `53b1432290545a7be55992fa47ec88687aa4de9f1cb65853a4b71cb07b8ec1c3`
- Guarded repair SQL: `a211c0d06a1baa2331317f243306157606713a2827d75757dfc7f8be3b7446ab`
- Gauntlet: `40dc7cd248ea22137009f79809ff8ca1c3f1cde8c5ad331fc9d5cace52174046`

Toolchain: Node 20.20.2; fast-check 4.9.0 and ESLint 10.8.0 pinned in package-lock.
Deployment wrapper syntax and checksum checks also passed. Its later adjustments
separate approval scopes and report failed SQL; they do not change the SQL tested
above. The first gauntlet attempt exposed the existing receiving failure; the
second exposed a report-parser bug (the harness writes failures to stderr). Both
are documented rather than weakening the business assertions.

SOA10368 changed during validation. Audit 2508666 records pickup loading at
2026-10-22 19:23:29 UTC. The guarded one-order repair then refused the changed
header and rolled back. Final read: Pick-Up, loaded, 357.32 sales units loaded,
zero packing warnings, zero packed sales quantity, zero repair audit entries.
The original order no longer needs repair. The combined deployment installed
only the future automatic release rule, using the `--install-rule` mode.
SOA10368 remained loaded with zero packing warnings and no repair audit.
The original one-order repair must not be rerun against its completed work.
