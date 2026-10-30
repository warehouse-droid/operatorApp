# CO-GOA-10919-10923 correction preparation

The user clarified: "Co to 3445 first." This preparation does not delete any
NetSuite record or change any live business data. The current flow fix remains
deployed. The proposed historical correction requires explicit approval to delete
the two posted item fulfillments.

Read-only NetSuite verification found IF159803 (1095903) from SOA10919 (1094559)
and IF159804 (1096033) from SOA10923 (1094575), both Shipped. Their source orders
are Pending Billing. The external IDs and every selected item's identity and
quantity match local load records 7159/7160 and the two completed posting
candidates. No invoices or later linked transactions were returned for these
four transaction IDs. Nine original cargo lines belong to the CO from 2967 to
3445. The CO is driver-completed and has not been received through Receiving.

Private original local and NetSuite snapshots are preserved under
`server/artifacts/co-10919-correction-20261027/before.json`. The validated local
plan is `plan.json` in the same directory. These are operational audit/rollback
records and are excluded from disposable test cleanup.

## Reviewable action

1. Recheck the saved source fingerprint, transaction identities, quantities, and
   downstream links immediately before execution. Abort on new business activity.
2. After explicit approval, delete only item fulfillment IDs 1095903 and 1096033.
   Verify both are absent and their source SOs have returned to Pending
   Fulfillment with no fulfilled quantities. Retain each deletion result. No
   accounting-period change is included.
3. Apply the prepared local correction transaction: reclassify loads 7159/7160
   as CO transfer evidence while retaining their original photos, timestamps,
   source pointers, and line snapshots; retire the two posting candidates as
   skipped with correction audits; clear the nine erroneous source loaded
   quantities and reopen the two SOs. Preserve source quantities and CO cargo.
4. Verify the SO group at Operator yard 3445. Receiving remains pending; do not
   fabricate confirmation, photos, or a receipt. Actual CO receipt then transfers
   the received quantities to Packed, waiting for the customer delivery load.

The accounting-period lookup was unavailable in SuiteQL. A read-only REST lookup
of accounting period 139 returned 403 because this integration lacks Manage
Accounting Periods permission. No alternate credentials or period changes were
attempted. NetSuite's own record/period restrictions must be respected during an
approved deletion; a rejection requires stopping, not bypassing it.

Oracle documents the item fulfillment DELETE operation in its
[REST API browser](https://system.netsuite.com/help/helpcenter/en_US/APIs/REST_API_Browser/record/v1/2022.2/index.html).
Its [transaction deletion guidance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N563543.html)
states that transaction details are not retained after deletion and describes
linked-record and closed-period restrictions. These are the reasons for the
private capture and explicit approval.

## Executed evidence

Reproduce the checks with:

```sh
sudo bash docker/run-isolated-tests.sh node tools/co-10919-checks.mjs
```

- Initial RED: all four original correction tests failed against the explicit
  unimplemented stub, with no import/collection failure.
- Final fresh run: six correction tests and twenty existing CO workflow tests
  passed, 26/26 total. The six correction tests passed again after mutations.
- The end-to-end correction test verifies restored Open SOs, untouched CO cargo,
  preserved original evidence, receipt into Packed at yard 3445 with 5 pallets
  and 4 layers, and a subsequent customer load containing the full original
  313.8 and 251.04 quantities.
- Negative tests verify existing NetSuite records block the local correction,
  changed source quantities block a stale plan, an audit failure rolls all local
  changes back, and repeated correction changes nothing.
- Three manual mutants were killed: omitted NetSuite absence check, incorrect
  load classification, and failure to clear loaded quantities.
- Correction module coverage: 132/132 lines and statements, 9/9 functions,
  43/44 branches (97.72%). The production NetSuite lookup boundary was not
  exercised with live deletion; external lookup responses were simulated in
  disposable tests while all local database logic ran unchanged.
- Syntax and scoped repository lint: four files, zero issues.
- Node v20.20.2. Correction module SHA-256:
  `56a8090ff7adaa16fe30e59748d074a5430463bd1c5f08309598bb2d3fa49d52`.
  Test SHA-256:
  `0067adccbf8a3785cab0c1a89ff29f002b74b52d04e8a5ef10de98bdf5a737ea`.

An early rehearsal caught a uniqueness conflict when both original load source
pointers were changed to the same CO. The correction now retains those original
pointers and changes only the business classification and CO identity, with an
explicit before/after audit. This preserves provenance and satisfies the unique
constraint. No assertions were relaxed.

Scope limits: no live NetSuite deletion was executed, and no approval has yet
been received. The entire repository suite and static type checking were not
rerun for this administrative tool. No dependency change or new quantity
arithmetic was introduced; existing quantity properties remain in the twenty
CO workflow tests. Test execution used the standard bounded disposable runner,
with automatic removal of all test containers, database storage, networks, logs,
coverage, and mutation source copies. Production health remained healthy.
