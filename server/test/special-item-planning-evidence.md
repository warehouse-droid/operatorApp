# Special Item planning and Save — evidence

Deployed on 2026-10-09 at 15:44 UTC. The shared Dispatch validator no longer
requires Special Item stock to be In Stock or excludes Vendor Pickup. Manual
Save Now, autosave, incremental commands, and snapshot restore use this validator.
PO approval, pending fulfillment changes, closure, quantity review, Attention,
and post-PO change checks remain effective.

The user authorized the change and required Save to apply the plan. Separate
spec approval was not obtained (autonomous run); the
[acceptance specification](special-item-planning-spec.md) records that interpretation.
Tier 3 checks were scoped to this shared planning/API change.

## Reproduction and final validation

The captured original server failed 17 of the 21 Save/restore scenarios with
SPECIAL_STOCK_NOT_READY. The four existing eligible scenarios passed. The
original Save responses returned HTTP 202, applied=false, and a recovery draft.
The final server passes all 21 scenarios and persists the active plan with
HTTP 200 and no recovery draft.

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Vendor, yard, and MBT delivery with ready, production, and low-inventory stock | `special-item-planning-save.test.js`: 18 manual/autosave cases | Pass |
| Save applies an already confirmed plan | Confirmed-plan Save Now case | Pass |
| No stock/method recovery response and active snapshot persists | Shared `verifyApplied` assertions in all 21 cases | Pass |
| Incremental Save and snapshot restore | Special PO incremental case and vendor-pickup restore case | Pass |
| Approval, review, closure and Attention protections | Guard unit tests; 15 approval/fulfillment, 2 approval HTTP, and 12 closure tests | Pass |
| Case share-lock serialization against delivery edits | Existing approval HTTP planning/fulfillment race | Pass |
| General save/recovery behavior | Existing recovery, compact-command and frontend save suites | Pass |
| Stock, fulfillment method and receipt are unchanged by planning | Shared `verifyApplied` database reread | Pass |
| Split/group reference expansion | Existing independent-planning unit cases and seeded reference property | Pass |
| Existing closure/approval error ordering | Legacy pricing HTTP closure-race assertion | Existing failure retained |

## Reproducible checks

Run from `/home/ubuntu/apps/operatorApp`:

```sh
python3 server/tools/special-item-planning-20261009/run.py baseline
python3 server/tools/special-item-planning-20261009/run.py red
python3 server/tools/special-item-planning-20261009/run.py final
```

The baseline and RED modes use the captured original validator. The final mode
runs static checks, HTTP Save tests with c8, all affected regression files,
manual mutants, and a seeded shuffled repeat. Every mode registers teardown
before startup and uses the repository's bounded isolated Compose configuration.

Final evidence is in `server/test-artifacts/special-item-planning-20261009`:

| Layer | Final result | Artifact |
| --- | --- | --- |
| Affected test suites | 120 tests: 119 pass, 1 unchanged baseline failure; zero new failures | `summary.json` |
| New Save/restore scenarios | 21/21 pass | `final-http.json` |
| Planning unit tests | 10/10 pass, including 60 property examples with seed 20261009 | `final-unit.json` |
| Type comparison | 7,386 existing diagnostics before and after; zero new diagnostics | `static.json` |
| Runtime lint comparison and regression-test lint | Zero new runtime messages; zero test messages | `static.json` |
| Added runtime line coverage | 1/1 covered; six deleted lines validated by regression and mutation tests | `changed-coverage.json` |
| Manual mutation | 3/3 killed; restored stock and vendor restrictions separately killed by the property and real HTTP Save tests | `mutations.json` |
| Shuffled repeat | 31/31 pass; Save scenario order shuffled with seed 20261009 | `shuffled-http.json` |
| Test resource policy and teardown | Containers, disposable databases and project networks removed; production healthy | `cleanup-final.json` |

Recorded tool versions: Node v20.20.2, c8 12.0.0, TypeScript 7.0.2. No
dependencies or production migrations were added. The runtime capability diff
removes one stock-status query and one rejection branch; it adds no network,
filesystem, subprocess, or environment access. Manual review of the task-only
runtime diff found no credentials. Dependency audit was not repeated because
the dependency set did not change.

Source manifest hash:
`6cf0d67b0f4eb8801979203e79143d9d0fb97bd9a961c75d0cfb4d32168c840d`.
The final runner persists the file hashes and computes this value in `summary.json`.

## Release and live verification

The release overlays only `src/dispatch-plan-repository.js` onto the latest live
app image. It retains the previous image for rollback, checks configuration and
environment equality, and leaves the database, Ollama, and webhook-worker
containers unchanged. The app passed live health and source-hash verification.

- App image: `sha256:820327517aa810bc41f1ab189f4b14e7746e438356cdcb878c98087289b18aed`.
- Runtime file hash: `6dabb5cd0f7687a051dde10ff792ef7bfde25a66f11c1b36d20554afc27257f2`.
- Recovery draft 19397 for plan 354 passes the live Special Item validator.
  The probe reads the original candidate and current active snapshot, validates
  inside a rolled-back transaction, and does not apply the draft.
- The case was Vendor Pickup when investigated and was changed concurrently to
  Yard Pickup. Its current method was preserved by this deployment; the automated
  Save scenarios independently verify Vendor Pickup.
- Both `docker ps` and `docker ps -a` show only the four production containers.

The deploy/verify commands are persisted in
`tools/special-item-planning-20261009/deploy.py`; live verification uses
`tools/special-item-planning-20261009/live.mjs`. Release logs and rollback
metadata are retained in `server/deployments/special-item-planning-20261009`.

## Limits and resolved issues

The broader suite is not wholly green. An existing pricing HTTP closure-race
assertion expects SPECIAL_CLOSURE_PENDING but receives SPECIAL_PO_APPROVAL_REQUIRED.
It fails identically with the captured original validator and the final validator.
The other approval, closure, and planning-lock tests pass; this task preserves
the existing approval-before-closure ordering. Unrelated application suites and
live NetSuite writes were not run.

Initial test setup omitted the browser-session audit field, then used a database
name and a missing PDF helper that one older suite did not accept. Those fixture
issues were corrected before the recorded baseline and final comparisons.
A concurrent app restart briefly interrupted one teardown health read; health
recovered, and the final teardown includes a bounded health retry.

The first release build used an image ID as a Dockerfile image name. It failed
before production changed. The corrected release tags the exact current base
image; the final checks were refreshed after that tooling correction. Failed
preparation logs remain in the separate `special-item-planning-20261009-prepare-failed`
deployment directory. Production business data and retained recovery drafts were
not edited by the deployment probe.
