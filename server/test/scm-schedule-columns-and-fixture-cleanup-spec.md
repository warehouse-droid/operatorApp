# Schedule columns and exact test-order cleanup

Spec approval: not obtained (autonomous run). The user explicitly authorized removal of the two named test orders and the schedule UI changes. No new dependencies or unrelated changes are planned.

## Acceptance criteria

1. Remove only `TOA-CO-DEPENDENCY-0FB08978` (6526455537), `TOA-GLOBAL-PICKUP-0FB08978` (7000263227768), and their verified synthetic dependent records. Retain a private backup first. Validate exact identities, fixture provenance, and absence of real execution before mutation. Rehearse under rollback, then apply atomically and verify the result.
2. Preserve real orders, assignments, historical execution and audit evidence. Any historical snapshot containing unassigned test cards is evidence, not a reason to rewrite a real plan. Remove active projections of the exact test orders where necessary.
3. Show ETA, Driver, and SLA as three labeled lines in one compact column, visible by default. Preserve their existing filters and all existing row editing, save, refresh, and reconciliation behavior.
4. Provide a keyboard-accessible Columns chooser for every data column and utility column available to the user's role. Users can hide and restore columns, including the combined column; retain at least one data column so the grid remains usable. Hidden cells and headers must not occupy grid space.
5. Remember column choices for the signed-in user and schedule surface in this browser. Invalid/unavailable storage must fall back safely. Existing width, font-size, and row-height preferences remain valid. Provide Show all and Reset layout recovery.
6. Changing column visibility must preserve unsaved row edits, selections, focus where possible, scroll position, and filter values. Saving a row and refreshing the schedule must retain column visibility.
7. Verify editable and read-only surfaces, hidden combined-column filters, targeted row replacement, and malformed preferences. Use existing Node/browser tooling in isolated containers; never run a fixture-creating test against production.
8. Deploy only the changed schedule static assets on top of the current production image, retaining a rollback image. Verify the served assets and service health.

## Failure model and verification

- Wrong-row or partial deletion: exact-ID/ref/provenance assertions, related-record review, a private backup, transaction rollback rehearsal, post-apply counts.
- Real work linked to a fixture: inspect dependency, assignment, and execution references; stop the destructive transaction if operational evidence appears.
- Grid misalignment or inaccessible settings: execute real frontend rendering in browser tests, compare visible headers/cells, and exercise keyboard/checkbox controls.
- Lost unsaved edits or preferences shared across users: browser interaction tests, user/surface isolation and storage failure tests.
- Unrelated deployment changes: derive the image from the running production image and copy only the schedule assets; compare their hashes after deployment.

The cleanup uses Tier 3 operational safeguards. The reversible frontend change uses focused behavior and browser regression checks. A full database-mutating application suite is outside this frontend/one-off-cleanup scope.
