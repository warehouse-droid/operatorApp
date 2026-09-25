# Operator kit fulfillment evidence

Spec: [approved acceptance criteria](operator-kit-spec.md). Approval: “Implement the plan.” Tier 3 (inventory and irreversible external fulfillment).

## Result and boundaries

The Operator SO target resolver reads the current REST sublist, SuiteQL kit parent relationships, and kit definitions whenever the stored SO includes a kit. It converts complete sets of physical components into one kit-parent fulfillment line. The immutable command retains physical component identities/quantities and the parent/member definition. Ordinary orders preserve their stored-line path.

For SOB120656 (997764), the corrected draft selects orderLine 1 quantity 95.6 and orderLine 2 quantity 1 at location 1. The sand remains item 599 in physical evidence; the posted kit parent is item 10126. Component orderLine 3 is absent from the request.

The production rehearsals are read-only and reconstruct the failed confirmation in memory. They do not save a new command, edit failed attempts, change packing, or create an Item Fulfillment. Deployment does not retry the order. Operators must make a fresh confirmation after reopening the order.

## Acceptance-to-evidence mapping

| Spec | Executable evidence |
| --- | --- |
| 1: Exact incident / physical evidence | `operator-kit.test.js`: SOB120656 exact payload and immutable sand evidence; `operator-kit.test.js` integration: real PostgreSQL hydration and load finalization |
| 2: Authoritative identities / repeated SKU / ordinary fast path | Runtime reader/target tests, repeated-SKU unit case, existing direct-orderline tests; live source reader against actual NetSuite |
| 3: Complete kits / quantities / current remaining | Member ratios, missing/unequal/fractional/excess cases; generated complete-kit and prior-fulfillment properties; source disagreement and combined allocations |
| 4: Supported shapes / fail closed | Nested, bin, serial, lot, missing flags, drop-ship and nonfulfillable cases; noninventory member case |
| 5: Freshness / recovery / verification | Changed definitions and remaining quantity; read failure before POST; duplicate-ID recovery; timeout recovery; wrong parent-item result; resumed attempt property |
| 6: Physical finalization once / preserved posting policy | Real DB quantities: item 2141 loads 95.6, kit parent 10126 stays 0, member 599 loads 1, one load record, one attempt. Existing admission/policy, posting concurrency, and location-parts regressions |
| 7: No new API, schema, dependencies, or item/account edits | Nine-file source manifest and immutable image overlay; no migration/public assets/package changes; production reader explicitly uses a read-only transaction |
| 8: Failure model | Focused tests, property-only mutants, adversarial malformed identities/definitions, existing duplicate/concurrency/partial-part tests, real DB rejection retaining stock |
| 9: Scoped deployment / validation | Exact live-image patch, candidate suite, before/after read-only replay, runtime hashes, health/auth probes, preserved container configuration/dependencies and automatic rollback |

The test files above are in `test/mbt/{unit,property,integration}`; the complete focused list is `tools/operator-kit-files.mjs`.

## Reproduction

Run `sudo -n bash tools/operator-kit-gauntlet.sh` from `server/`. It runs static checks, focused tests with c8, property-only manual mutations, seeded file-order checks, the full suite, baseline comparison, dependency/secret checks and source-hash verification. No new packages are installed. Existing Docker test image: `mbbs-retired-confirm-test:20260914`; Node v20.20.2. Tool versions are pinned in the existing package lock; the original lock hash is retained in `test/support/operator-kit-baseline-hashes.json`.

Deployment commands: `python3 tools/operator-kit-deploy.py prepare`, `build`, `preflight`, `check`, `apply`, `verify`. These require the captured pre-task worktree at `/home/ubuntu/operator-kit-baseline-20260918`. The scoped before/after patch is also persisted as `test/support/operator-kit-changes.patch`; the gauntlet itself uses only repository files and the existing test image.

The final source identity, counts, coverage, mutation results and deployment result are recorded below after completion.

## Audit notes and limits

- The initial domain stubs failed all 32 acceptance/property tests. Runtime contracts reproduced the child-line payload and missing preflight/duplicate-check behavior before integration. Additional source-disagreement and combined-quantity guards were observed failing before implementation.
- Real DB fixture setup initially used two incorrect column names; these were corrected without changing behavioral assertions. The successful finalizer assertions verify real loaded quantities and load records.
- The first live replay set sales quantities on lines that use physical conversions. The replay was corrected to reconstruct physical quantities in memory from the order conversions; production data was never edited.
- An initial mutation of only one remaining-quantity guard survived because another guard rejected it. A meaningful prior-progress mutant exposed a missing property case. The property suite was expanded to verify both accepted remaining quantities and rejected excess quantities; the final five mutants are real behavioral changes and all must be killed by properties alone.
- Finalization review found that the kit parent kept a fully loaded pickup in `partial_loaded`. The real DB assertion reproduced this, then passed after excluding kit parents from remaining stock; a second case verifies that two of three complete kits remain partially loaded.
- The first secret scan also inspected unchanged legacy test fixtures and flagged a pre-existing lease-token fixture. The scan was corrected to cover this task’s production patch and changed tests/tools, matching its intended diff scope.
- Baseline harness detail: its raw full-suite run reported 20 failures. One was a Dockerfile contract mismatch because the baseline snapshot omitted root Dockerfiles and inherited the test image’s Dockerfile. The other 19 are the previously recorded worktree failures. The current-worktree full runs mount the correct Dockerfiles; no Dockerfile or runtime-build behavior was changed by this task.
- Existing full-suite failures and static diagnostics are preserved and compared by identity. Unrelated failures were not fixed in this change.
- No browser rendering change was made; new browser visual tests are not applicable. Existing policy/adapter/integration tests cover the unchanged Operator contract. No dependency audit/install was needed because both package manifests remain byte-identical to baseline. Python deployment orchestration is syntax checked and exercised through candidate packaging, live rehearsal and deployment.
- V1 intentionally rejects nested or ambiguous kits, duplicate member rows within one kit, and member inventory-detail requirements. One kit must use one inventory location. Ordinary lines may use other supported locations through the existing IF-parts mechanism. Different unit representations that disagree with the current kit member ratio fail closed.
- This release uses the active stored-order-line command strategy for kit commands. Existing Delivery Prep SO ownership remains with driver completion; the release does not enable an additional posting path or alter gates.
- A pre-POST read cannot atomically lock NetSuite against a separate external editor. The checks run immediately before submission within the request pool, and verify returned parent items, quantities and locations. Actual NetSuite POST acceptance remains to be observed on the operator’s next fresh confirmation.
- The evidence is not a proof of all NetSuite account configurations; production validation was limited to read-only access and the observed single-level kit shape.

## Final gauntlet results

Source manifest: `test-artifacts/operator-kit/final/source.json` (48 files). Canonical manifest SHA-256: `51c0a3254217dcc803adec0c7d5a7d2f5232199748158c20534234ee8218a208`.

| Layer | Final result | Artifact |
| --- | --- | --- |
| Focused unit/property/DB/adversarial/concurrency regressions | 189 passed, 0 failed | `final/focused.log` |
| Full suite | 2807 tests: 2787 passed, 19 existing failures, 1 skipped; 0 new failures | `final/full-comparison.json`, `final/full.log` |
| Changed executable lines | 209/209 covered | `final/changed-coverage.json` |
| Property-only manual mutants | 5/5 killed | `final/mutations.json`, `final/mutant-*.log` |
| Types / lint | 0 new diagnostics; 243 existing type diagnostics and 1 existing lint diagnostic | `final/static.json` |
| Seeded file-order checks | 23 files passed, seed 120656 | `final/health.json`, `final/health-*.log` |
| Changed-code secret scan / dependencies | 0 findings; package and lock hashes unchanged | `final/secrets.json` |
| Source integrity | All manifest hashes unchanged during the final gauntlet | `gauntlet.log`, `final/source.json` |

Artifact paths in this table are under `test-artifacts/operator-kit/`. The raw baseline’s Dockerfile harness mismatch is explained above. These counts belong to the completed run after the pickup-status fix. The 19 remaining failure names exactly match the previously recorded display-fix worktree failures.

## Deployment result

Deployed at `2026-09-18T17:28:09.656213+00:00` to the Operator app at `https://test.mbbsoperation.com`.

- Image: `mbbs-operator-app:operator-kit-20260918-v1`.
- Immutable image ID: `sha256:d13988099bb5619bfba53213c5e727596ebd7e90797d2e83fb910dedcd8fe333`.
- Scope: nine server files over the exact running display-fix image; no public assets, migrations, dependencies, environment, mounts or other services changed.
- Packaged candidate: 189 focused tests passed, 0 failed.
- HTTP probes: health 200; anonymous delivery API 401, both localhost and public host.
- Runtime hashes: all nine deployed files match the candidate manifest.
- Live read-only replay: orderLine 1 quantity 95.6 and kit parent orderLine 2 quantity 1, both location 1; the stored physical sand evidence remains item 599 quantity 1.
- Failed attempts 57, 58 and 59 have identical before/after hashes. Local order-line/packing hashes are identical before and after deployment. No Item Fulfillment was created by validation.
- Rollback image and release evidence: `/home/ubuntu/operatorapp-deploy-backups/operator-kit-20260918-v1/`.

The operator should reopen SOB120656, confirm the actual physical quantities and submit a fresh confirmation. Existing failed commands remain unchanged.
