# Stock request followups, 2026-10-27

Spec approval: not obtained (autonomous run). User authorized the changes and
confirmed manual SCM selection at the destination yard. Tier 3: decisions and
quantity conversion affect inventory workflow. No dependencies, commits, or
production test data. Build a narrow delta over captured live source and retain
rollback; use the bounded disposable test runner and automatic teardown.

Acceptance scenarios:
1. SCM can reject expired, unused approved pickup lines with a reason and current
   revision. Partial rejection preserves the original expiry; no NetSuite stock
   refresh is needed. Missing reasons, stale revisions, transfers and handoffs
   fail without writes. Existing partial-decision approval-window behavior stays.
2. A 1046.2 SQFT Urban Slab request at 52.31 SQFT/pallet checks 20 PLT, not 1.
   Use reviewed quantity when present. Round partial pallets upward. Prefer saved
   packing or authoritative unit conversion. Unknown conversion asks SCM for PLT;
   never silently assumes one or treats SQFT as pallets. Old checks become stale.
3. SCM manually completes an uncommitted Stocking line as Stock available at
   destination yard. Store actor, destination and timestamp. Other lines remain
   open; completing the last line completes the request. No PO/TO, stock movement
   or automatic inventory decision. Reject already committed lines and Sales API
   attempts; duplicate/stale submissions cannot overwrite work.
4. Every History datetime uses America/Toronto, including summer/winter DST,
   independent of device timezone. Preserve stored instants and date-only values.
5. Backorder SO/PO previews are inside their reference spans and open an in-app
   dialog with close/download, loading and error handling. Sales has SO only;
   SCM also has PO. Existing Special preview behavior remains.
6. Sales attaching an SO accepts reviewed Backorder lines as customer acceptance
   in the same transaction, with an audit event. SCM review is still required.
   Preserve declined/closed lines and do not accept later revised stock responses
   silently. Apply the authorized acceptance to STREQ-000166 after deployment.

Failure model: stale actions and double clicks (revision and concurrent tests),
partial batches (transaction rollback), linked-order race (shared locks), wrong
unit/rounding/overflow (boundary and generated properties), unauthorized action
(real HTTP role tests), misleading previews (browser modal/role tests), timezone
drift (foreign-zone summer/winter browser checks). No new external writes.

Validation: reproduce bugs before edits; relevant complete regression suites,
types/lint/secrets and changed-line coverage; four intentional bugs killed by
tests and property-only run; reversed focused suites; real API/browser execution.
Retain concise evidence, delete test containers, volumes, networks and artifacts.

Appendix: The manual destination-yard completion also covers Backorder materials.
No PO/TO or inventory mutation; preserve any linked SO. Refuse completion after
PO/handoff commitment or on terminal materials. Remaining materials stay open.
Existing test fixture queries must use purchase demand's request_line_id, and
packing fixtures must specify conversion fields when conversions exist.

Appendix: SO linking intentionally supersedes the earlier review-flow rule that
attaching an SO leaves customer decisions pending. Reviewed pending materials now
become accepted and the stage becomes confirmed; quantities, prices, canonical
order identities and quotation details remain unchanged. The manual SO link is
available after SCM review. Existing UI checks count review forms specifically,
since SCM now also has a separate destination-yard completion form.

Changing the original requested quantity invalidates a prior live-stock result,
even when an older reviewed quantity is still saved on the line.

The existing live-stock queue endpoint returns HTTP 202 Accepted. Browser tests
must verify that response and its persisted job quantity; HTTP 200 was an
incorrect initial test expectation, not a requested API change.

A Backorder fully completed from destination-yard stock must appear in the
Completed case-stage filter for Sales and SCM, and must not appear in Closed.
This must agree with the completed status shown in the request detail.
