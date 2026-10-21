# Sales delivery instructions: NetSuite memo and dates (Tier 3)

Spec approval: not obtained (autonomous run). The user authorized implementation
and deployment after tests. No dependency or credential changes; no real order
writes during tests. Reuse isolated Docker/SQL/browser tooling, no git commits.

Verified read-only against live NetSuite metadata on 2026-09-29:
`custbody7` = Note (the existing memo instruction), `shipDate` = Ship Date,
`custbody4` = To be delivered by. Both dates are nullable date-only fields.

Acceptance scenarios:

1. Authorized Sales loads the complete, unfiltered NetSuite instruction note and
   both dates. Dates retain the calendar day, including leap days and DST dates.
2. Sales saves those three fields directly to the same NetSuite SO. Only changed
   mapped fields are PATCHed. Blank dates/notes explicitly clear their field.
   Standard memo, lines, quantities, prices, location and delivery method are
   never in the update payload.
3. A changed note/date, order identity, yard, status, or delivery method rejects a
   stale save with a readable conflict message. Closed/cancelled/delivered orders,
   another yard, public Sales, Dispatcher and unauthenticated callers cannot edit.
4. A saved assignment is idempotent. Concurrent same-revision saves cause at most
   one remote mutation. If the response is lost, reread to verify success; if the
   result cannot be verified, keep the user's input and report uncertainty.
   Retrying the same reviewed values safely recognizes an already applied update.
5. Only verified remote values update the local memo, expected delivery date,
   parsed driver instruction and instruction revision. Existing app-only text,
   media and Dispatch routing/planning remain intact. Audit/event hooks run.
6. The editor labels both dates and provides Save to NetSuite and Reload NetSuite
   values. It displays loading/saving status, disables all page action controls
   while waiting, retains drafts through errors/local saves/language changes, and
   handles structured errors without [object Object]. English/Chinese responsive
   layout is usable; no stale-order response replaces a newly selected order.

Failure model and verification:

- Unauthorized/misdirected writes: real authenticated HTTP and SQL access tests,
  adapter identity checks, exact PATCH contract, hostile input/property tests.
- Concurrent or stale edits and delivery completion: existing order/advisory
  transaction locks; simultaneous SQL service tests and conflict properties.
- Partial external success/timeouts: boundary fault injection before/after PATCH,
  verify on reread, same-value retry tests. NetSuite does not provide an atomic
  cross-system transaction; no claim of rollback for a successful remote PATCH.
- External NetSuite user edits in the final read/PATCH window: compare immediately
  before and after; narrow PATCH protects unrelated fields. A same-field edit in
  that interval remains an API-level limit, to document in evidence.
- Stale local cache / translated instructions: verify refreshed raw/parsed memo
  and revision; existing driver/translation regressions remain required.
- UI loss/duplication: real browser with delayed/error boundary responses, draft
  retention, repeat click and keyboard checks. Test remote boundaries, not UI logic.

Gauntlet: RED, full affected/neighbor suites, lint/types, changed-line coverage,
generated properties, manual mutants (also property-only), randomized suite order,
real SQL/HTTP/browser execution, source/diff secret review, scoped overlay deploy
and read-only live verification. No new dependencies or schema migration planned.

2026-09-29 test-contract clarification: the Sales page asset version must advance
for the new editor and responsive styles. Update the existing exact CSS version
assertion from 20260812-delivery-image-720p-v1 to 20260929-netsuite-edit-v1;
retain every card sizing/wrapping assertion. This is a changed cache contract,
not permission to skip the layout regression.

Live verification amendment: the shared NetSuite queue delayed the new read
behind background synchronization. Both Sales NetSuite endpoints must use the
existing interactive staff priority middleware after authorization, preserving
the shared concurrency limit. The authenticated HTTP transport test verifies
that both reads and writes run in the interactive context. Other routes and
background synchronization retain their existing priority.
