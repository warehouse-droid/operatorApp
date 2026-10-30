# Special delivery methods during Dispatch arrangement

Spec approval: not obtained (autonomous run under the user's change request).
Old-coder Tier 3: linked-order integrity and concurrent delivery updates.

1. An active Special request permits delivery-method editing while its SO, PO,
   or handoff is planned, including Dispatch arrangement. The Sales editor is
   available on desktop and phone. Backorder planning restrictions are unchanged.
2. Changing vendor pickup, yard pickup, or delivery uses the existing verified
   fulfillment service. Existing SO/PO identities, commercial lines, pricing,
   and saved Dispatch plan snapshots are preserved. SCM and Dispatch receive
   the existing durable method-change notice and review the arrangements.
3. An unstarted handoff is rebuilt for the new method, requiring route selection
   when applicable; the old handoff must not retain an incompatible route.
   Saving the same pickup method retains its planned handoff without an alert.
4. Started/completed physical work (including travel or work in the assigned
   load), completed/closed orders, unauthorized yards, stale revisions, and
   unverified remote changes remain blocked. Recheck execution at finalization.
5. Concurrent updates retain the existing case lock and revision protection;
   retries preserve their saved target and publish only one notice. A failed
   database finalization rolls back local changes and notices together.

Failure model: stale transport directions (handoff reset, preserved plan and
team-notice assertions); altered commercial data (before/after order snapshots
and existing adapter tests); concurrent edit or start (real database lock and
interleaving tests); unauthorized edits (existing HTTP/scope checks); a hidden
editor or stale cached asset (browser checks and asset version update); partial
NetSuite update (existing journal/retry/verification contract).

An external NetSuite write cannot be atomic with a driver start. Existing
remote verification and the final execution recheck retain an incomplete
journal for review if execution begins during an external update; tests use
the existing fake remote boundary, never production NetSuite credentials.

Setup: existing Node test runner, PostgreSQL, Playwright, fast-check, ESLint,
TypeScript and c8; no dependencies, migrations, or commits. Run the relevant
Special fulfillment suite, compare existing failures, check changed-line
coverage and static diagnostics, exercise three meaningful manual mutants,
and retain concise evidence. All temporary source copies/logs are under the
disposable runner's unique artifact directory and removed after teardown.

The old requirements rejecting merely planned Special orders are superseded
by scenario 1; their tests will be changed to assert allowed planned updates
and rejection once execution starts. Other assertions remain in effect.
