# Customer delivery choices after PO arrival

Spec approval: the user explicitly confirmed that after PO arrival only Pickup
at inquired yard and Delivery may be selected. The implementation details below
are an autonomous Tier 3 specification, not separately approved.

This visibly supersedes the previous rule treating every completed PO journey
as completed customer fulfillment. SPREQ-000080 is active in Dispatch arrangement;
its supplier PO arrived, its SO is Pending Billing and already maps to Pickup,
and no customer execution evidence was found. Do not change its saved selection
as part of deployment; restore the dropdown so the user can choose and save.

1. Completed supplier pickup/drop-off and PO receipt do not hide or reject
   customer fulfillment editing. An inbound via-yard handoff is not the customer
   leg. Started customer SO work, a started direct customer handoff, completed
   customer fulfillment, closed requests and cancelled/closed SOs still block.
2. After canonical PO receipt or a completed physical PO drop-off, offer exactly
   yard_pickup and mbt_delivery. Reject vendor_pickup on claim, saved retry and
   finalization, including arrival between claim and completion. Before arrival
   all three methods remain available. Backorder planning rules stay unchanged.
3. Saving either permitted method on an active customer request works even when
   accounting already records fulfillment/billing. Only delivery headers may be
   patched in NetSuite; every commercial line, price, discount, fulfilled/billed
   quantity and line closure state is snapshotted and verified unchanged.
   Ordinary commercial adjustments keep their original unexecuted-order guard.
   New journals use a versioned snapshot; version-1 retry behavior stays strict.
4. Existing yard authorization, revisions, saved-plan recovery, durable team
   notices, Dispatch snapshots and local transaction rollback are preserved.
   Verify desktop/mobile options and live SPREQ-000080 using read-only checks.

Use the existing bounded disposable runner, Node/PostgreSQL, Playwright,
fast-check, TypeScript, ESLint, c8 and manual mutation. No dependencies, migrations,
or commits. Retain concise baseline/final evidence and operational release records;
remove all temporary test resources. The existing two unrelated header-note
failures remain the recorded baseline. No global fleet lock spans NetSuite calls.

## User correction: fulfilled SOs are locked

The user clarified that a fulfilled SO permits no further edits and its request
should be completed. This supersedes scenario 3 and the version-2 header-only
plan above. That proposed code was never deployed and has been reverted; the
existing strict NetSuite adjustment and delivery adapters are retained.

The user explicitly authorized changing SPREQ-000080 locally to yard pickup and
reconciling it. Fresh NetSuite evidence verifies SOA10517 line 5155457 as 135.39
of 135.39 SQFT fulfilled. The audited local correction changed revision 13 to 14;
the existing completion view now reports Completed with editing locked, without
changing NetSuite or canonical order headers/lines.

Remaining UI/API work applies to unfulfilled SOs: PO arrival permits exactly
yard pickup or Delivery, while fully fulfilled SOs remain locked. The no-webhook
question calls for checking existing refresh behavior and explaining a shared
scheduled status-polling fallback; no new background schedule is authorized here.
