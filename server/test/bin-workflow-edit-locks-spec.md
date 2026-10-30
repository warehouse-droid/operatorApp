# BIN workflow edit locks — 2026-10-23

Spec approval: not obtained (autonomous run under the user's change request).
Tier 3: editing linked instructions must not corrupt planned work or driver history.
No dependencies, commits, production test data or migrations are planned.

1. Given both exchange legs are unplanned and unstarted, all route settings are
   editable, including when an unplanned receiving delivery is linked. Withdrawn
   assignments alone must not keep the editor locked.
2. Given either exchange leg is planned, sequence and same/different-bin choices
   are locked in both the UI and server. The unplanned collection's dump site and
   after-dump destination remain editable until the collection itself is planned.
3. Saving collection settings must preserve the planned delivery's instructions,
   revisions, claims, evidence, requested windows and saved plan byte-for-byte.
   Conversely, planned collection settings cannot be changed through a forged save.
4. Retaining a receiving link preserves its cargo and updates its post-dump source.
   Changing that link must remove the old dependency without leaving the old
   receiving order dispatchable with a borrowed bin. Its order, cargo and windows
   remain; it can select a valid bin again. Currently linked targets remain visible.
5. Started/completed work stays protected. Stale revisions, conflicting linked
   targets and concurrent plan/edit commands roll back atomically. Existing
   automatic paired planning and driver execution continue to work.

Failure model: overly broad locks (real editor + DB tests), rewriting a planned
leg (full before/after snapshots), dangling links (relink/unlink/assignment tests),
stale or racing edits (revision and fleet-lock race tests), issued-history changes
(withdraw/reconfigure tests), and cargo loss (existing cargo + driver regressions).
Use the bounded disposable runner, static checks, meaningful changed-line coverage,
properties and manual mutations. Deploy only a validated narrow live-source overlay.

Additional edge case identified during review: when the Collection and its onward
receiving delivery are planned, the popup must retain the current receiving order
in the locked fields and still save a change to the unplanned exchange replacement.
The planned Collection and its plan must remain byte-for-byte unchanged.
