# Confirmed Special Request notes, free delivery, and long desktop scrolling

Spec approval: not obtained (autonomous run). User requests editable Note after
confirmation, explicitly says to hide the zero-fee line, and reports desktop
scrolling stuck on long detail pages beyond just Audit Trail. Preserve prior
SO/PO recovery and do not leave test containers or databases behind.

1. Sales can edit the public request Note on an active confirmed Special Request,
   including linked SO/PO and planned requests. Use a separate Note-only form
   after the full header locks. Preserve decisions, status, materials, prices,
   delivery fields, order drafts, attention and operation state. No NetSuite
   writes. Keep auth, Sales role, yard, feature flag, revision and terminal-state
   checks; audit one actual change, none for unchanged text. Preserve multiline
   Unicode text and unsaved input on errors/conflicts; explicit reload resolves
   a conflict. Full delivery/header changes retain their existing guards.
2. Keep an entered delivery fee of 0 in the editor, but omit its displayed charge
   row, quote line and new SO charge. Paid delivery remains unitless, undiscounted
   and appears once. Remove stale unissued zero-fee draft charges when editing;
   preserve materials, totals and PO costs. No rewriting already issued NetSuite
   orders or historical PDF bytes.
3. Sales and SCM regular/special requests can scroll through long details to the
   visible last control/entry and back, with real wheel input on desktop. Include
   long text, many lines, short laptop viewports, repeated round trips, and
   narrow-screen regression coverage. Keep queue access usable.

Failure model: note-only edits could unlock unrelated changes or race with
revision updates (HTTP negative/concurrent/rollback checks); zero could be
mistaken for missing data or an old paid line could leak into the quote/SO
(fixtures/properties/positive fee checks); long nested scrollers could clip or
trap the bottom (real browser geometry and wheel checks).

Setup: existing cached test tooling only, standard isolated Compose and resource
slice/limits, registered teardown before startup, task-specific source baselines
and deployment overlay on the current production image. No dependencies, schema
changes, NetSuite writes, unrelated workspace rewrites, or commits.

Desktop scrolling clarification: all 12 original long-detail tests passed when
wheel input stayed in the nested detail pane. They did not reproduce the user's
reported freeze. Desktop still locks the outer page, so wheel input outside the
pane cannot scroll a long request. Replace that dependency with document
scrolling for long details on all screen sizes; retain a bounded, sticky desktop
queue. Test actual page movement with the pointer over the workspace margin,
last-control reachability, and repeated bottom-to-top round trips. Keep the
original passing nested-pane diagnostic log as evidence of the limit.

Legacy SO clarification: before a fresh SO submission, remove unissued saved
zero Delivery Charge rows in the claimed draft, so both the created payload and
later local line reconciliation omit the same row. A previously submitted SO
must retain its saved zero-charge row for exact recovery verification. Test
both claim states and recover a submitted legacy SO with no creation or writes.

Property clarification: the zero-quote mutant survived the original random seed
because no zero fee was generated. Every property trial must check both zero
and a generated positive fee, with charge-count and total invariants for each.
This strengthens the existing zero-fee criterion; it does not change runtime
behavior or relax a test assertion.
