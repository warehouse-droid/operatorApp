# SOM06255-S2 and SOM06256-S2 Dispatch visibility — 30 September 2026

Both splits are restored in production following the user's confirmation that
they should still be available for Dispatch. A rollback rehearsal first proved
that activating the two definitions restores source search, indexed search and
order details. The committed correction changed only those definitions' active
flags/timestamps, the catalog generation/timestamp and two audit records.

| Split | Preserved quantity | Retirement timestamp (UTC) | Restoration audit |
| --- | --- | --- | --- |
| SOM06255-S2 | 1,274.4 SQFT | 2026-09-14 16:12:10.341 | 25283 |
| SOM06256-S2 | 52.75 SQFT | 2026-09-23 13:22:35.686 | 25284 |

The correction checked the rehearsed before-state SHA-256 under the fleet and
definition advisory locks and row locks, wrote a private before-image and audit
entries, and verified unchanged source headers/lines, plan 324 and related driver
records before committing. No application deployment or NetSuite write occurred.
The retained before-image is mode 0600 at
`test-artifacts/dispatch-s2-visibility-20260930/restore-before.json`; its original
is `/app/data/support-fixes/dispatch-s2-visibility-20260930-1790803715250.json`
in the application data volume.

## Retirement investigation

Each retirement timestamp coincides with a `replace_plan` command triggered by
`load_truck_updated`: plan 324 revision 28 → 29 for SOM06255-S2, and plan 335
revision 34 → 35 for SOM06256-S2. The audit records nearby unrelated driver/truck
changes. There is no explicit unsplit action or S2 driver delivery-completion
record in the inspected history; both S1 siblings remain active and completed.
The cancelled S2 PO allocations were preserved.

The old browser code used the same lifecycle reconciliation for a rejected edit
rollback as for deliberate undo/redo. Restoring a snapshot older than the current
pool queued missing splits/groups for retirement; the next accepted save could
persist that queue during an unrelated truck change. This matches both incidents'
audit timing. The exact preceding browser rejection was not retained, so this is
an evidence-supported explanation rather than a complete event replay.

The fix deployed on 24 September already suppresses lifecycle reconciliation for
all three rejected-edit rollback paths. The exact current production browser
source was captured and verified to contain these guards. Running the existing
regression against the retained old production image reproduced eight failures
and one passing history test; the current deployed source passed **9/9 tests**,
including 50 fixed-seed generated lifecycle cases. No runtime code change was
necessary for this recovery. Earlier corrupted flags required explicit recovery.

## Live verification

Six real authenticated HTTP searches passed with HTTP 200 through both
`/api/dispatch/orders` and `/api/dispatch/v2/order-pool`: individual searches for
each restored S2, and `SOM0625` searches returning both S2s and both S1s.
The S2s are unplanned and available for planning. Both delivered S1s are returned
with `dispatchCompletionStatus: completed` and `dispatchPlanningRestricted: true`.
Completion therefore preserves search visibility while preventing replanning.

Source headers/lines remained unchanged during HTTP verification, both restored
definitions remained active and temporary diagnostic authentication was removed.
Observed HTTP response times were 16,189–17,745 ms; search latency was not changed.
The verification tool passed Node syntax and the repository's ESLint checks after
correcting its loop-brace formatting. The host lacks Node, so regression and
syntax/lint checks ran in the existing network-isolated test image. No dependencies
were installed, no unrelated workspace files were edited and no commit was made.

Artifacts are under `test-artifacts/dispatch-s2-visibility-20260930/`:
`restoration-result.json`, `live-http.json`, `old-rollback-tests.log`,
`deployed-rollback-tests.log`, `tool-check.log` and `source-hashes.json`.
Only the existing focused regression was rerun; no runtime implementation changed.

Repeat the live read verification from the server directory with:

```sh
sudo docker exec -i mbbs-operator-app-app-1 node --input-type=module - \
  < tools/dispatch-s2-visibility-live.mjs
```

Existing tabs need a page refresh to clear their retired-card state and load the
current browser code.
