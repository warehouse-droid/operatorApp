# Existing-plan creation recovery

Spec approval: not obtained (autonomous run). Tier 3: saved-work preservation and asynchronous responses.

The user authorized fixing October 8 Dispatch save blocks after order reconciliation. The active plan retained its routes, but rejected drafts omitted them. Creating an already-existing dated plan currently adopts its revision without hydrating its routes.

Acceptance tests:

1. Creating a date that already contains a saved plan loads its complete snapshot, including assigned orders and loads, before adopting its revision; the acknowledgement baseline matches that snapshot.
2. If local edits exist and the server returns an existing plan, retain all local edits and the original revision; reject replacement with an actionable message. A save must send no PUT/command in this case.
3. An actual new, empty revision-zero plan still accepts the first local draft without clearing it.
4. A response for a different date, a missing identity, or malformed routes cannot replace the board or fence.
5. A date switch or edit during the request invalidates that response without changing the current board or revision.
6. HTTP failures retain local state. Creating an existing plan with zero loads but a nonzero revision still hydrates it.
7. Across generated saved route shapes, accepted existing snapshots preserve every load and order; drafts are never silently overwritten.

Failure model: route loss is covered by snapshot/baseline assertions and the production recovery's existing executed-prefix guard; stale responses by controlled asynchronous tests; dirty-draft overwrite by negative tests; incorrect first-save blocking by revision-zero tests; incomplete deployment by served-asset hashes and a narrow two-file release. Driver history is protected by operational transaction rehearsal, audit records, and before/after digests. No backend guard is disabled.

Setup: use existing Node test tools and pinned development dependencies in bounded disposable Docker containers. Add this spec, one frontend test, repeatable test/mutation scripts and evidence. Keep baseline file copies and hashes; make no git commit and add no dependency. Deploy only verified Dispatch browser files. Remove disposable containers, dependency volumes and networks at completion.
