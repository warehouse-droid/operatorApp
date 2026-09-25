# Dispatch plan 331 recovery merge

Applied at 2026-09-20 04:57 UTC at the user's explicit request to combine the
current plan and the failed draft. The stored plan date is **2026-09-19**.

## Exact scope

- Current confirmed plan 331, revision 33; recovery snapshot 17811.
- Retained every existing truck, load, stop, and protected execution identity.
- Added Dao's Load 4 on BC71838, containing TOB01115 followed by
  GOA-8942-8943 (SOA08942 and SOA08943), with its four physical stops.
- Retained the saved GOA-8930-8931 delivery address and TOB01111 cargo.
- Did not reintroduce billed SOA07539 splits present in the failed draft.
- Invalidated only the new load's stale route timing, which was based on the
  draft's blank predecessor address. Its automatic start begins at the saved
  preceding load's finish, minute 820.
- Preserved the original failed draft.

## Why the draft was blocked

The failed draft cleared GOA-8930-8931's delivery address and retimed its
dropoff. It also removed TOB01111 line 4977214 (PER-MM80S-2237-SCG,
326.48 square feet / four pallets), changed the PALLET deposit quantity from
29 to 25, and represented those 25 deposits as cargo pallets. No entire
protected order was removed. The snapshots establish these differences,
but do not identify whether the dispatcher or an automatic refresh caused them.

## Verification

The persisted operation is `server/tools/merge-dispatch-plan-331-recovery.mjs`.
It checks the exact plan and draft content fingerprints, the revision/date,
absence of a newer failed draft or an active edit lease, and missing existing
assignments before applying. It holds the shared fleet and date locks and uses
the normal V2 command, including its regular downstream synchronization queue.

- Normal save rehearsal rolled back successfully.
- Final V2 command rehearsal rolled back successfully and left revision 33
  and its original content digest unchanged.
- The complete rejected draft, each conflicting order edit individually,
  and deletion of an executed predecessor were rejected (four negative checks).
- The merged candidate passed prefix, assignment, and dependency validation.
- Commit produced confirmed revision **34**, with digest
  `19435cede4a1147de350e50e41cc87cfc50431357b7f5fb521e7ce5ee5d78b4c`.
- All **21** driver records, including their evidence, had identical complete
  database-row fingerprints before and after the save transaction.
- Existing generated driver job IDs and their ordering were preserved for
  Dao, Li, and Cheng. All preexisting truck/load/stop JSON stayed equal.
- The four new group/member/order projection references were present; the
  added load belongs to Dao/BC71838 and remains unstarted and incomplete.
- Audit record **22472**, action `dispatch_plan_recovery_merged`.
- Command `user-recovery-331-17811-merge-v1` completed dependency, CO, SCM,
  and delivery synchronization with zero attempts/errors by 04:57:50 UTC.
- A fresh read of the committed Dispatch plan includes Load 4 and passes the
  executed-prefix policy against storage with no conflicts.

No application code was deployed. No driver job was completed or fabricated.
No browser rendering check or general application regression suite was run;
this was a bounded data recovery through existing application code.

## Subsequent source-attribution check

- **TOB01111 is a confirmed NetSuite update.** Incoming webhook 6896 at
  2026-09-18 19:10:16 UTC contains item 4773 at quantity 326.48 and PALLET
  quantity 29. Webhook 6960 at 22:51:40 UTC omits item 4773 and contains
  PALLET quantity 25. Reconciliation event 71610, source `webhook`, applied
  precisely that line set at 22:51:56 UTC. The deposit-to-cargo-pallet
  classification in the draft is a separate local projection concern.
- **The GOA address loss is not established as a NetSuite edit.** Dispatch
  audit 22434 records the correct address being entered for GOA-8930-8931
  at 2026-09-19 11:57:47 UTC. Both source sales orders still hold that
  address, with parse source `manual-dispatch-details`. Their latest retained
  NetSuite order webhooks precede that correction. Failed drafts 17806–17811
  instead contain a blank group address and blank SOA08930 child address.
  A stale grouped-order refresh is a plausible explanation; the exact refresh
  path was not reproduced. There is no basis here to blame a manual dispatcher
  deletion for these two differences.
