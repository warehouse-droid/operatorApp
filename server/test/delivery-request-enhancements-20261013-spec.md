# Delivery request conversation, load quantities and previews

Autonomous run under the user's enhancement request. Spec approval not obtained
separately; the request authorizes implementation and disposable verification.

1. Sales and Dispatch see a conversation board immediately after Remarks.
   Existing Dispatch proposals and Sales counter messages appear with author,
   team and Toronto timestamp, in chronological order. Each team can send a
   nonempty reply (maximum 2000 characters) without confirming or editing the
   request. Only its revision, audit metadata, conversation and unread alerts
   change. Replies work on submitted, approved, secured, expired and cancelled
   requests. Empty, oversized, stale and unauthorized replies change nothing.
2. Replies use the existing transaction, row lock, operation ID and event stream.
   Retrying one operation records one message and emits one invalidation; two
   competing revisions have one winner. Rollback leaves no message or alert.
   Both teams receive unread updates; displayed revision receipts do not hide
   newer messages. Reply drafts survive transient failures and incoming updates.
3. POS outbound rows contain Full POS qty and Loose POS qty, nonnegative whole
   pallet counts whose sum is positive and determines transport capacity. Values
   survive creation, editing and re-raising. Existing unsplit requests display
   their saved quantity as full POS with zero loose POS.
4. New BIN requests select Aggregate: Gravel, HPE, Screening or Crusher Run.
   Outbound quantity is in Yard, positive with at most two decimal places. Trips
   equal ceiling(yards / (configured nominal BIN yards * BINs per trip));
   nominal capacity comes from the database, never client claims. Legacy BIN
   requests retain their original BIN-count pricing until edited. Quote evidence
   binds both quantity fields, aggregate, unit and current BIN capacity.
5. Sales can attach an optional valid EST number during creation/edit/re-raise.
   The number is normalized and persists. The EST must belong to the requesting
   yard. Preview before submission and from saved requests displays its live
   customer, date, address, item quantities, units, rates and totals. Missing or
   unauthorized estimates expose no document and leave requests unchanged.
6. Both teams can preview every linked SO from the saved request. Preview checks
   request access and current linkage before retrieving the original NetSuite
   PDF. Arbitrary, removed or other-yard SOs are denied. Previews never create,
   confirm or modify NetSuite documents. Preview errors are visible and closing
   the dialog releases document resources and restores focus.
7. Existing request creation, expiry, pricing, multi-yard consolidation, approval,
   time changes, linkage, delivery instructions, alerts and filters remain covered
   by the full delivery request regression suite. Narrow existing browser label
   expectations change from Quantity to Full POS qty as required by this spec.

Failure model: incorrect charges are checked at capacity boundaries and with
generated quantity properties; partial/duplicate replies with rollback, races and
replay tests; document disclosure with role, yard and current-link tests; unsafe
HTML with hostile text browser tests; stale drafts with browser interaction;
deployment drift with captured release hashes and scoped files if deployed.

Setup: use existing Node, Playwright, fast-check, TypeScript, ESLint and c8 tools.
No new dependencies, commits or production test data. Use the standard isolated
Compose configuration and cached test tooling, bounded by mbbs-tests.slice,
memory, CPU, PID and tmpfs limits. Register teardown before any tests; remove
containers, disposable volumes and unused networks, verify docker ps/ps -a and
production health. Preserve source baselines, logs, coverage and mutation evidence.

## Authorized production deployment

The user explicitly authorized deployment with "deploy", then requested
"deploy the driver PWA as well". Include the existing driver upload reliability
implementation under its recorded acceptance specification. Rebase the scoped
runtime overlay on the current live image and preserve intervening production
changes. Patch only the driver diagnostic import/route in the live server.
Use the already verified driver asset generation v45 and its existing protocol
version. Build the diagnostic unique index concurrently, verify validity, and
record migration 282 only after it succeeds. Keep operational audit records and
rollback images. Verify the combined candidate's delivery suite and driver
unit/property, real HTTP and mobile fault workflows before cutover. Afterward,
check public/local health, asset hashes, private routes and PWA cache wiring;
perform read-only EST/SO preview checks where live documents are available.

Live verification found that NetSuite stores estimate requesting yards on the
main transaction line: all 17462 visible estimates have an empty transaction
header yard. Estimate lookup must prefer the header yard when present and fall
back to the mainline yard, preserving the same requesting-yard access check.

The expanded estimate record can return numeric unit IDs without display text.
For these records, resolve NetSuite's original unit labels through a read-only
transaction-line query. Show labels rather than internal IDs; an unresolved unit
must produce a visible preview error rather than display a misleading quantity.

## Conversation excludes system updates

The user clarified that the Sales & Dispatch conversation must exclude system
updates. Show only text written by Sales or Dispatch, including proposal/counter
notes and optional comments sent with workflow actions. Keep expiry, reminders,
instruction-update notices and generated status/time/SO-link summaries in Request
history. A workflow action with no written comment contributes no conversation
entry; an action with a comment contributes only that comment. Preserve existing
human messages, their author/team/time/order, and the full audit history. Extract
comments from the known generated prefixes on already saved events. Record future
comments separately in the existing event snapshot, with no schema or data rewrite.
System notices must not crowd earlier human messages out of the conversation's
200-message limit. The browser uses the dedicated conversation response and shows
its empty state when there are no human messages. Reply behavior, workflow state,
pricing, alerts and access rules remain covered by the existing delivery suite.

Use the existing test tooling and bounded disposable Compose project; no new
dependencies or commits. Verify the exact scoped candidate, preserve intervening
production releases and Driver PWA files, and deploy under the user's existing
deployment authorization. Spec approval: not obtained separately (autonomous run).

Read legacy event candidates in bounded batches until the latest 200 human
messages are collected or the request history is exhausted. A cached operation
retry returns a cleaned conversation limited to that response's saved revision,
without later messages or another audit/alert write.
