# Grouped Dispatch actions — release evidence

Status: deployed and verified; all release gates passed with zero new full-suite failures.

Spec approval: not obtained (autonomous run). The user authorized the grouped-action fixes, added address override to scope, and previously authorized deployment. This is a Tier 3 run because allocation identity and execution guards affect operational data. The executable specification is [link-to-fix-spec.md](link-to-fix-spec.md).

## Findings and resulting behavior

| Action | Finding and final behavior | Evidence |
| --- | --- | --- |
| Link TO / Link PO | A global group could disappear when resolving it on another plan date. Resolve authoritative group membership and current source lines; retain real child line identities, quantities and stale-command checks. | `test/mbt/integration/link-to-fix.test.js`; `group-action-fix.test.js` G2; generated link properties |
| Link TO after completed CO | Legacy shared pickup references could incorrectly mark source SOs as started. Exempt only exact saved-route and immutable completed-CO evidence; uncertain evidence and real SO activity remain blockers. | Unit/integration Link TO tests, adversarial cargo/evidence cases, manual mutants |
| Linked TO in Operator Planned | Inherit the confirmed SO/group assignment for direct linked TO reads: list, detail, date/truck filters, load and notifications. Keep independent TO planning flags unchanged. | Link TO L3 integration and generated assignment-transition tests |
| Address override / dispatch details | The group was treated as a local card. Save each authoritative SO/PO/TO child in one transaction, including split children, then refresh group and catalog. Replace and clear overrides; retain current quantities, PO allocations and CO routing. | `group-action-fix.test.js` G1/G3; authenticated `group-action-http.test.js`; UI submission tests for all three types; generated address round trips |
| PO Set Yard | Previously looked up the group label as a PO. Update each real PO pickup and return refreshed children. Delivery override remains separate from vendor pickup. | G3 integration and authenticated HTTP tests |
| Driver / Dispatch PO address | Cached stop addresses could override current order data. Refresh group dropoff/residual projections; Driver and Dispatch navigation use current dropoff addresses after editing and clearing. | G3 tests: raw source rows, catalog, stale-plan reconciliation, Driver job and actual Dispatch address function; existing PO residual tests |
| Grouped Split | Could use a group label as a nonexistent source order. Require ungrouping and splitting the intended child. Block the UI, command API and equivalent legacy plan save. | G4 unit and integration tests; split-guard mutants |
| Grouped Consolidate Pick | The legacy draft only used the first item. Require ungrouping and selecting the intended child before this action. | G4 actual frontend function regression |
| Selected action buttons | Narrow panels squeezed Link TO into neighboring controls. Wrap action rows and keep buttons at usable widths. | Production renderer/CSS Chromium geometry and click checks |

Reviewed paths that already retain the intended identity: PO/TO unlink and mode changes use persisted relationship IDs; delivery instructions use a child SO selector; operator execution expands children; planning/group/ungroup retain route-group membership. CO yard transfers retain CO cargo identity. Manual customer completion is unavailable for groups. A physical CO operation must not blindly complete its source SOs.

## Verification

Final results are from the frozen `final-v3` source. Artifact directory: `test-artifacts/link-to-fix/final-v3/`.

- Focused packet: **202/202 passed** across 23 files, including existing allocation/operator-lock concurrency regressions.
- Changed backend coverage: **264/264 lines executed**. This is changed-line V8 evidence, not a claim of complete branch coverage. Frontend behavior is covered separately by actual-function tests and Chromium layout checks.
- Static: **0 new diagnostics**, **0 lint findings** in configured scope; **243 existing type diagnostics** remain. Legacy monoliths are syntax-checked and behavior-tested; this release does not introduce a new lint configuration for them.
- Exact app and worker candidate sources: **202/202 passed for each**.
- Existing Driver oriented-schedule harness: **56 checks passed**.
- Manual mutation: **12/12 killed** by the targeted packet; **4/12 killed** by properties alone. The other eight expose limits of the property layer and are covered by unit/integration/UI regressions.
- Randomized file order: **202/202 passed**, 23 files, seed 6531, isolated database per file.
- Chromium: five selected-action widths (280/320/390/480/760) without overlap, clipping or disabled hit targets; three matching-modal widths (390/768/1280) fit.
- Full suite: **2,876 tests, 2,856 passed, 19 failed, 1 skipped; 0 new failures**, 554 isolated test files. Baseline: 2,844 tests, 2,824 passed, the same 19 failures and 1 skip. Exact failure names are in `final-v3/full-comparison.json`; the existing failures remain unresolved.
- Secret scan: **0 findings** in the scoped patch and checked tooling/support files. Dependency and lockfile hashes are unchanged.
- Final source-hash verification and changed-line whitespace check: passed. Complete gauntlet exit status: **0**.

All 12 selected manual mutants run against both the targeted regression packet and the property suite alone. The properties are intentionally reported separately; they do not cover every execution-proof or UI condition. Property generation covers 100 CO-reference permutations plus repeated generated link/quantity, plan-assignment, and address round-trip cases.

RED evidence includes cross-date lookup, button overlap, group address persistence, unsafe Split/Consolidate Pick, stale group quantity (10 instead of 14), and stale Driver/Dispatch PO addresses. Final review also checks a 20-unit PO group with 4 allocated units: editing/clearing keeps 16 on the PO route and leaves allocation rows unchanged. Invalid dates and missing/closed/retired children roll back all writes. CO manifests and driver evidence are compared unchanged.

The randomized packet initially exposed fixture collisions because committed HTTP fixtures shared a database with deterministic legacy IDs. The runner was corrected to use the repository's existing per-file cloned-database isolation. No assertions were relaxed. A new artifact directory initially had root ownership; ownership was corrected before the final run. Three old, empty test networks were removed after inspection when Docker exhausted its test subnets; live networks were untouched.

## Reproduction and source identity

Run from this server directory:

```sh
sudo -n bash tools/reproduce-group-actions.sh
```

This extracts `test/support/verified-group-actions-source.tar.gz`, verifies the recorded source hashes and runs `tools/link-to-fix-gauntlet.sh` against the exact isolated application/test/tool snapshot. Use `bash tools/reproduce-group-actions.sh --verify-only` to check extraction and hashes without running tests. Dependencies and package lock are unchanged. The shared workspace has other changes, so source is identified by the verified snapshot rather than a new commit.

- Scoped manifest: `test-artifacts/link-to-fix/final-v3/source.json` (56 files).
- Manifest SHA-256: `f92e08d1c306d3cc229078f574938efe239b55c8eb783b8c561b1c93a5aa7570`.
- Exact source archive SHA-256: `7a7d3151f9f68fe259910f05ff21ce45ec59d52a9c365161e3496cfe1f6333c2` (2,959 files).
- Node: 20.20.2; PostgreSQL 18 test database; existing Docker tooling, no new packages.
- Test-tool image: `mbbs-retired-confirm-test:20260914`, digest `sha256:0a5ee3f2197eb21d9959c4cd71d12917e7ce5e7b112c02845681ec9eea7c460c`.
- Browser-tool image: `mbbs-return-batch-browser-test:20260918`, digest `sha256:24c59eeb0e091a95c18dd603f66684461d8de31f4f97d0f293f75d11fe3e53eb`.
- Additional Driver command: `sudo -n bash tools/operator-display-test.sh unit node src/driver-oriented-schedule-harness.js`.

The scoped patch was applied to the shared workspace with zero-fuzz context matching. Reversing it in a trial copy reproduced the original bytes, preserving concurrent field-sales work. The worker uses an older unrelated outbound-location implementation; its import hunk was rebased onto a shared import anchor, and the exact worker candidate passed the same tests.

## Deployment and practical limits

The scoped release script is `tools/link-to-fix-deploy.py`; commands are `prepare`, `build`, `check`, `preflight`, `apply`, and `verify`. Apply requires final source/coverage/static/mutation/full-suite evidence and verified app/worker candidates. Rollback images are retained. No database migration, NetSuite posting, completed driver-event rewrite, business link or bulk address change is part of this release.

Read-only candidate verification of **GOM-6531-6537 / TOB01103** passed for September 18 and 19: SOM06531 item 2340 suggested quantity 127.9 and SOM06537 item 1784 quantity 2. Ten existing linked TOs also returned their inherited Operator assignments. No real link was created because the user has not selected quantities or confirmed a linking operation.

Known limits: no live packing/loading or posting was performed; no external NetSuite call was changed. Chromium tests exercise production rendering and layout, while authenticated API tests exercise persistence in an isolated database; this is not a claim of a complete authenticated browser workflow. No separate performance benchmark or new dependency vulnerability audit was run because no performance contract or dependencies changed. The manual mutant set and generated cases provide bounded evidence, not exhaustive proof. Full-suite baseline failures must remain visible in the final result.


### Verified deployment

Deployed to `https://test.mbbsoperation.com` at **2026-09-18T23:09:07.807313+00:00**. Both services are running with zero restarts and matching release source hashes/configuration. Local and public health returned 200; anonymous Delivery access returned 401. Dispatch HTML serves the new CSS and JS asset versions. The database and Ollama containers were unchanged; no migration ran.

- App image: `sha256:b766c17d0c4cb41b9463cf31c9fbe846ea9b93ee68e6eb6f706dcaf164f42bb2`.
- Worker image: `sha256:2f7952b01fdf3fd5df1d996035e55c34cf003ce990b89b7c3fcb3755cdd1eeaf`.
- Release/rollback manifests: `/home/ubuntu/operatorapp-deploy-backups/group-actions-20260918-v3`.
- Sanitized deployment result: `test-artifacts/link-to-fix/final-v3/deployment.json`.

After deployment, read-only matching for GOM-6531-6537 / TOB01103 again passed for both September 18 and 19, with the same two real child lines. Inherited Operator assignments were checked for TOB01093, TOB01102, TOB01095, TOB01086, TOB01055, TOB01044, TOB01043, TOB01019, TOB00991 and TOB00981. No business link was created.
