Linked PO feed and Driver pickup correction — 2026-10-28

The source rebuild copied fresh split-order items into their group without
restoring the PO allocations owned by that group. It retained the PO pickup
manifest. The resulting order-detail feed therefore showed a linked PO while
its item rows had no allocated sales quantities. PALLET became 21 EACH minus
zero in that feed, although allocation 468 correctly recorded 21 EACH linked
to LOINC-038227. Allocation 469 also correctly recorded 2030.91 SQFT. The saved
plan's item projections were already correct; the catalog definition was not.

The previous sales-UOM arithmetic fix was present and passed its regression
tests. It could not compensate for a producer dropping its allocation input.
The earlier explanation about cleanup alone was incomplete. Cleanup was a
secondary issue: an explicit unstarted pickup could survive after its cargo
became empty. The producer defect is now reproduced independently of that stop.

Historical comparison through the actual catalog repository and browser code:

| Order | Shape | Before correction, after source rebuild | After correction |
| --- | --- | --- | --- |
| GOB-123453-123464 | Ordinary members; same current load | Techo only | Techo only |
| GOA-10588-10650 | Ordinary members; Oct 27 successful load | Techo only | Techo only |
| GOA-10208-10209S1 | Split member; Oct 26 successful load | Incorrect 2967 plus Techo | Techo only |
| GOM-6894S1-6895S1 | Split members; today's incident | Incorrect 150 plus Techo | Techo only |

The successful historical split load retained correct data in its saved
snapshot, but replaying the later source rebuild reproduced the same failure.
The retained audits show today's GOM was initially added with Techo only.
Available snapshot history does not identify the exact first insertion of its
incorrect 150 stop; no claim is made about that missing timestamp.

The existing source rebuild now stages split/group definitions, clears stale
PO projections, reads active allocations in one batch, and saves item totals
and pickup manifests in the same transaction. Calculations use the shared
sales-UOM allocation totals. No read-time enrichment, timer, retry, client
refresh, dependency, migration or external NetSuite write was added. Existing
TO relationships and native pickup locations survive the PO-only reset.

Spec approval: not obtained (autonomous run), as recorded in
`linked-po-pickup-20261028-spec.md`. Confidence is limited to the acceptance
criteria and checks below; the spec did not receive separate human review.

| Acceptance behavior | Executable evidence |
| --- | --- |
| Empty source stop removed; other/shared cargo retained; input immutable; repeated cleanup stable | `dispatch/unit/linked-po-pickup-20261028.test.js` |
| Partial, unknown, overridden and unlinked pickups retained; packing cannot override sales residual | Same unit file; 200 generated cases, seed 68946895; existing sales-pickup and linked-PCS suites |
| Started visits, completed prefix and active travel preserved | Same unit file; `dispatch/integration/linked-po-pickup-repair-20261028.test.js` |
| PO references scoped to pickup vendor, deduplicated, escaped and retained offline | Same unit file; actual live Driver route verification |
| Driver page and installed cache use the same updated script | Service-worker install execution in the unit file; served asset hash verification |
| Four historical shapes survive repeated rebuilds; partial/cancelled links correct; reads do not rebuild | `dispatch/integration/linked-po-pickup-feed-20261028.test.js` |
| Failed feed publication rolls back source, splits, group and generation together | Same feed integration file, injected database trigger failure |
| Repair preview, stale revision refusal, audit failure rollback and concurrent calls | Repair integration file; four passing scenarios |
| One-time correction preserves cargo, rolls back previews, audits once and is idempotent | Feed integration file; live correction and repeat previews |
| Scoped release preserves configuration and dependencies | Deployment manifest, file hashes and deployment verification |

Reproduce the complete scoped verification from the repository root:

```sh
sudo -n env MBBS_LINKED_PO_BASE_IMAGE=mbbs-operator-app:rollback-linked-po-pickup-20261028 bash docker/run-linked-po-pickup-checks.sh node tools/linked-po-pickup-checks.mjs
```

The command uses the retained baseline image, the repository's bounded test
configuration and a new disposable database. Its traps remove containers,
volumes, networks and generated artifacts on success or failure. No live
database credentials or data volumes are mounted. Historical fixtures contain
sanitized order shapes and quantities, with synthetic database identities.

Final fresh verification: 124 checks across 20 affected test files, 123 passed
and one unchanged baseline failure. All 35 focused checks passed, including
16 existing frontend pickup checks imported by the replay. All 71 changed
non-comment JavaScript lines executed. Seven of seven deliberate faults were
caught; both arithmetic mutants were also caught by the generated property
test alone. Mutant restoration was verified by file hashes and a fresh rerun
of the focused tests. Test-file order was deterministically shuffled and each
file received a separate database cloned from the migration template.

The unchanged baseline failure is
`the installed Driver shell cannot mix old DB/route code with photo recovery code`:
`driver-upload.js must be versioned in driver.html.` That older test expects
an October 16 asset version while the baseline already serves October 23.
It was neither weakened nor skipped. The new install test checks the actual
Driver shell/script contract for this release.

Static analysis: zero new TypeScript diagnostics (3012 baseline, 3002 current)
and zero new lint diagnostics (19 baseline and current). All changed JS files
passed syntax checks. These are delta checks on a legacy JavaScript codebase,
not claims that the whole application is type- or lint-clean. The complete
unrelated application test suite and physical-device installation were not
run. Coverage is reported for changed lines; no 100% branch-coverage claim is
made. The adversarial checks include hostile markup, partial allocations,
active travel, concurrent corrections and transaction failures. Dependency
manifests were unchanged; the scoped diff scan found no embedded credentials
or new runtime network, process, filesystem or environment capabilities.

Tool versions: Node 20.20.2; ESLint 10.8.0; TypeScript 7.0.2; c8 12.0.0;
fast-check 4.9.0; pg 8.21.0. Exact runtime/test/tool hashes, actual Node version,
per-file results, baseline failures and mutation outcomes are in
`linked-po-pickup-20261028-evidence.json`.

Published at 14:27:13 UTC. Only the eight files listed in
`tools/linked-po-pickup-files.json` were overlaid on the live image. Unrelated
concurrent workspace changes were excluded, and two intervening production
releases were preserved. The final image is
`sha256:ee981d5604d716ccdb55a28fc3f6b92fca861abc4a7e79ddf22c15b3eced1b77`;
its tested baseline is
`sha256:54df92b787133a8fd2c4da0bafaa9adf0393c7c335a097065407522b8a591f6e`.
Local and public health endpoints returned 200; served Driver assets matched
the release hashes. Production dependency containers and configuration stayed
unchanged. App-only rollback data is retained under the deployment directory.

Live correction: plan 371 moved from revision 37 to 38, audit 31854. Only
GOM's empty pickup `stop-8ee7d1bd-4c91-4764-97f3-0bcad5954b17` was removed.
TOB01269's valid 150 pickup remains. Li's completed travel record 7546 and
in-progress Techo pickup record 7550, including their timestamps, stayed
unchanged. Both SOM06894-S1 and SOM06895-S1 now carry PO reference LOINC-038227
in the actual Driver route and offline snapshot.

Six active groups initially had missing matching allocations. Today's group
was corrected with the plan; the existing rebuild corrected four more after
release. The remaining older GOA-9140S1-9143S1 definition was corrected once,
audit 31856. A read-only scan of all active SO groups then found zero missing
matching allocation totals. Repeating both corrections made no changes.
Read-only historical detail checks returned Techo only for all three comparison
orders. Operational evidence is in
`deployments/linked-po-pickup-20261028/live-verification.json`,
`repair-result.json`, `feed-repair-result.json` and `idempotence.json`.

Final cleanup verified both `docker ps` and `docker ps -a`: this task left zero
test containers, volumes or networks. Its temporary source trees, test logs,
coverage output and database storage were removed by the disposable runner;
generated helper bytecode and superseded staging images were also removed.
Another active `mbbs-repair-tests-3719921` project was left untouched. Production
health still returned 200 and the deployed source hashes still matched the
passing evidence. See `cleanup-verification.json` for that operational record.
