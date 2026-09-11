# CO cargo preservation — evidence and deployment

Tier 3. Spec approval: **not obtained (autonomous run)**. The user authorized the
fix, specific repair, stress/replay tests, and deployment conditional on passing.
This is layered evidence within the specification, not proof of every possible
production interaction.

## Outcome

Deployed `mbbs-operator-app:co-cargo-preservation-20260905-v1` at
2026-09-05 10:50 UTC, after the complete gate passed.

- Image: `sha256:c74d4acfa7b20f05813ff0b40f6ad4e4df39a311b2a6fb96315c1c421ce031dd`.
- Source base: `bfa00f4f674da517d06e82439f0d7af8d27c392f`, with scoped uncommitted changes.
- Frozen runtime tree: `cda589a7708ca32c00d3d34bc3176c9de0dc625bc8aa85555e8d229bf76f35ad`.
- App healthy; worker running; both zero restarts. Database not restarted.
- Health, Dispatch menu/planning page, and versioned JS returned HTTP 200.
- Startup error/fatal/uncaught/unhandled scan: zero matches in both services.

CO-GOA-7453-7455 was repaired in plan 310, Sept 4, Li Load 4: revision **59 → 60**,
product quantity **559.68 / 6 pallets** plus PALLET quantity **6**, with pickup
**2967 before the existing 12441 delivery**. Database line rows 504/505 were
already correct and were not changed. All unrelated order snapshots and existing
stop content were compared to the private backup and remained identical.
Archive **16924** and audit **19008** record the change. A subsequent read-only
preview returned `changed:false`.

## Final fresh gate

From the repository root:

```sh
bash server/tools/dispatch-co-cargo-gauntlet.sh
```

The entry point builds only the scoped files onto the previous live image,
extracts an immutable candidate, creates fresh artifact and isolated database
directories, and runs every layer below. The two unrelated PO-draft repository
files are explicitly compared to the baseline image and remain undeployed.

Final artifacts: `server/test-artifacts/co-cargo-preservation/final-4e7LAm/`.
All numbers below are from that completed run, after the last implementation
and test-code edits. Earlier failed/aborted runs are retained separately.

| Layer | Result |
|---|---|
| Project full suite, `npm test` | **440 files, 2,198 tests passed**; zero failures |
| Ordered CO/Dispatch tests, isolated per file | **17 files, 109 tests passed** |
| Seed-shuffled suite health, seed 74537455 | **17 files, 109 tests passed** |
| Changed runtime-line coverage | **230/230** across six runtime JS files |
| Manual mutation | **6/6 killed**, also **6/6 killed by property tests alone**; source hashes restored |
| Generated stress | 1,000 partial/full feed interleavings plus 1,000 manifest cases; repeated full/incremental saves and simultaneous-dispatcher tests |
| Syntax / existing ESLint configuration | Passed; zero warnings/errors |
| Strict TypeScript | New cargo helper and mutation runner passed |
| Secret scan | **33 paths**, zero high-confidence findings |
| Exact production-data repair rehearsal | Two lines/six pallets restored; **14 unrelated load assignments preserved**; rollback-only |
| Current Sept 4 frontend-function replay | Zero validation conflicts; one added physical pickup; five existing stop IDs retained; unrelated loads unchanged |

Toolchain: Node **20.20.2**, c8 **12.0.0**, ESLint **10.8.0**, TypeScript
**7.0.2**, fast-check **4.9.0**. No dependencies were installed or changed.
No git commits were made. Temporary test databases/networks were removed;
reports, frozen source copies, private backups, and rollback image were retained.

## Seven-day replay

Read-only capture window: **2026-08-29 09:20 UTC → 2026-09-05 09:20 UTC**,
exactly 168 hours. Partial endpoints span eight Toronto calendar dates.

- 5,226 source records; **5,229 event/projection comparisons**, zero mismatches.
- **436 historical plan states** checked for legacy compatibility; zero
  compatibility conflicts or unintended legacy-route mutations.
- **2,962 late-order injections**; zero post-injection validation failures,
  executed-prefix violations, or driver-scope failures.
- 323 captured driver-activity records; actual SCM and NetSuite-derived streams
  present. All supported replay acceptance assertions passed.

This is a snapshot/event projection and route replay, **not an exact replay of
every original API/network transaction**. It records **77 evidence gaps**,
38 strict source-state conflicts in incomplete/legacy history, and no captured
`splitPoDirectShip` or `groupPoLink` interaction examples. These were not silently
removed or presented as exact-save coverage. CO save behavior is additionally
tested against the database and the current production-data rehearsal.

The private capture is required to reproduce the historical portion; it is an
ignored artifact, not committed customer data. The read-only capture tool is
`tools/dispatch-planner-history-replay.mjs`; the offline command is persisted in
the gauntlet. Capture file SHA-256:
`56c5cad00414138849ab6163ce1c42b9f74ffac5fbb448dd3ea126e9d4ae1b6c`.

## Specification mapping and limitations

| Specification behavior | Evidence | Status |
|---|---|---|
| Compact child identity, hydration, feed/save merge, true CO groups | `dispatch-co-cargo-preservation.test.js` frontend tests; existing CO group/identity suites | pass |
| Canonical quantities, immutable/idempotent cargo, missing-data safety | CO property and integration suites; six mutants | pass |
| Source allocation metadata cannot hide independent CO cargo | Explicit RED → GREEN database regression and property-only mutant | pass |
| Empty physical pickups stay skipped | `dispatch-required-pickups.test.js` and existing route regressions | pass |
| Executed work, stale edits, source identity remain protected | CO lifecycle, targeted repair, and concurrent-command tests | pass |
| Specific repair, backup, audit, idempotence, unrelated content | Repair integration/rehearsal plus live read-only backup comparison | pass |
| No new APIs, dependencies, source-line mutation or PO-draft deployment | Scoped image, source/config comparisons, secret scan, live verification | pass |
| Exact historical transactional replay | Historical payloads incomplete; see gaps above | unverified |
| Full browser rendering | Chromium binary/image unavailable; actual frontend functions exercised, including feed/save and pickup reconstruction | unverified |

Frontend coverage is limited to extracted production-function spans, not the
entire browser application or DOM. New helper/repair modules have 100% line and
function coverage, but branch coverage is **71.79% / 93.54%**, not 100%.
Legacy JavaScript is syntax/lint checked, not comprehensively statically typed.
No visual/layout code changed. No throughput/SLA benchmark or platform matrix
was claimed; no such budget/matrix was requested. Dependency/license audit was
not rerun because dependencies did not change. New capabilities are bounded
database reads and the explicitly authorized, guarded operational repair CLI.

## Failures encountered, not waived

Original empty-cargo regressions failed before implementation. Additional feed
and saved-plan tests failed against the frozen old frontend. An adversarial raw
allocation test exposed a new edge case; it was fixed before rebuilding and
rerunning the full gate. Test-data capture initially discarded allocation and
fee evidence and misclassified SCM audits; fidelity regressions preceded those
corrections. Exact mutation-inventory/cache-key contracts were updated visibly,
without broadening assertions. The shuffled harness initially shared a database
despite fixtures requiring per-file clones; the existing isolated runner fixed
the harness while retaining concurrent-request assertions. Whole-module legacy
coverage thresholds were replaced with the specification's changed-line check,
not represented as globally covered code.

Rollback/configuration and private repair backups:
`/home/ubuntu/operatorapp-deploy-backups/co-cargo-20260905.1nMl7T/`.
Image rollback is documented there. Data rollback must check the current revision
and subsequent edits; never overwrite later work with an old whole-plan snapshot.
