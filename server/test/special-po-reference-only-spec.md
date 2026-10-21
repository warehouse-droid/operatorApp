# Special Request PO linking and creation after a reference-only SO link

Autonomous repair requested for SPREQ-000038. Spec approval: not obtained
(autonomous run). No new dependencies, migrations or commits. Preserve the
existing working tree and deploy only the tested changes over the current image.

1. A manually linked approved SO and accepted request lines without item mappings
   or any saved order draft can link an existing PO by number. Validate revision,
   role, vendor, yard, activity, ownership and synchronization; leave all SO and
   PO records, mappings and existing drafts unchanged. Recorded linking survives
   webhook refresh and supports vendor-to-yard arrangement. Direct allocation
   remains unavailable without reviewed line relationships.
2. The SCM page displays every accepted material from that reference-only request
   in the purchase review, with its description, quantity and UOM. Require a
   nonnegative vendor cost and explicit discount percentage, including zero.
   Preserve existing saved purchase reviews and desktop/phone behavior.
3. Preparing the purchase review creates missing purchase draft rows using the
   standard MBBS-Special Order item 2055. Invalid, missing, duplicate and foreign
   lines, stale revisions, unavailable item master, existing PO and submitted or
   conflicting operations reject atomically. A repeated unsubmitted review
  replaces its own purchase details without duplicating rows.

Implementation constraint discovered during the first green run: legacy
purchase-readiness checks require local Sales quantity/UOM fields. For a
reference-only SO, initialize those local fields from the original inquiry;
they describe the request and do not assert an SO line mapping. Keep the actual
SO and the absent SO draft unchanged. Custom arrangement must also skip this
item-mapping requirement while retaining stock readiness and direct-route guards.
4. Creation uses the reviewed purchase quantities, units, costs, discounts and
   pallets, with the case externalId and SO reference note. A reference-only SO
   keeps its quantities, descriptions, units, prices and existing lines intact.
   Recover an existing native PO for the same SO/vendor/yard without rewriting it;
   reject partial, ambiguous, pending, foreign or inactive native links. Retain
   marker recovery and the durable no-resubmission protection after uncertain
   outcomes. Record independent linkage and wait for mirror lines before planning.

Failure model: accidental SO edits are checked using before/after snapshots and
mutation; incorrect PO ownership with HTTP identity and revision tests; duplicate
PO creation with native-link/marker/lost-response tests; empty or partial reviews
with browser, atomic database and generated inputs; missing handoffs with webhook
and route checks; production drift with baseline hashes, a narrow image overlay
and rollback. No live purchase is submitted during validation.

Setup: existing Node, Playwright, fast-check, c8, ESLint and TypeScript in the
cached test image. Use the standard isolated Compose configuration with test-only
credentials, mbbs-tests.slice and memory/CPU/PID/tmpfs/init bounds. Register
teardown before starting; remove task containers, database storage and networks,
then verify docker ps, docker ps -a and production health. Keep logs and evidence
in server/test-artifacts/special-po-reference-only-20261006. Run the full affected
Special Request suite against the captured baseline and candidate, with zero new
failures; run targeted tests, types, lint, coverage, mutations and hostile inputs.

## User clarification (supersedes criteria 1, 2 and native recovery in 4)

“please ensure the manual SO link and manual PO link do not check anything.
for Review and create Purchase Order, if the sales used manual SO link, then
we use the request information to create PO”. The user confirmed “Existing
synced order; skip all business comparisons”.

Manual linking resolves a unique existing synced number and preserves role,
revision, exclusive case ownership and concurrent/submitted operation integrity.
It does not check customer, vendor, yard, order approval/activity, accepted
decisions, stock, item mapping, saved drafts, dispatch allocation or dispatch
planning. Missing cargo mirrors do not prevent recording the link; arrangement
continues to wait for synchronized cargo and retains its own route/readiness
checks. Manual links do not modify existing order records or draft lines.

For every manual SO source, including one with an old saved SO draft, PO
review defaults to accepted request materials, their inquiry quantity/UOM and
description, plus SCM’s saved confirmed purchase review when present. Creation
uses those purchase details in a standalone PO, preserves the linked SO, and
never reads its lines, synchronizes it, or recovers an SO-native PO. App-marker
recovery and uncertain-outcome protection remain. SO approval and dispatch
planning do not govern this standalone creation; normal review, role, revision,
request lifecycle and purchase input validation still apply.

Archived v1 evidence and native-recovery tests are superseded at
server/test-artifacts/special-po-reference-only-20261006/superseded-v1. The
interrupted v1 all-suite run was deliberately stopped and fully torn down.
New tests and intentional old contract updates follow the clarified behavior.

Contract updates are explicit: Special manual SO tests now accept business
mismatches and leave compatible draft identities untouched. Custom PO tests
retain role/revision/reference/ownership/operation tests and accept foreign or
inactive orders and absent cargo. Existing app-created-order, quantity-review,
line-decline and description-sync fixtures explicitly select standalone source
so their stricter assertions remain covered. Their previous files are archived
under previous-contract-tests. Two synthetic setup mistakes (an invalid draft
UOM and a wrong response-vendor column) were corrected; the final baseline RED
run fails on behavior, not setup.

TypeScript/checkJs checks every changed JS module and its dependencies against
the same captured baseline and requires zero new diagnostics; existing project
diagnostics are saved and reported. The final focused suite also exercises the
existing manual-link authorization, conflict, recovery and Sales browser tests.
Concurrent PO creation and marker-invisible retries are checked using the real
repository and HTTP NetSuite boundary. No production data repair is performed.

Removing the manual-link prerequisites also permits PO-before-SO order. A
ready pair must produce its handoff after the second link in either order,
without requiring another NetSuite edit/webhook. Add an integration regression
first, observe its failure before changing the SO-link handoff, and rerun the
full candidate suite after the small consistency correction.

Final type comparison counts repeated diagnostics as well as diagnostic kinds.
The initial category comparison missed five added occurrences of existing
implicit-any diagnostics in the UI. Add JSDoc annotations without changing
behavior, rerun the final verification, and rebuild the prepared image.
The full final behavior suite remains applicable to this annotation-only edit.
