# BIN planning: reuse the Dispatch planner

This correction supersedes the separate BIN UI in mbt-bin-planning-spec.md.
The user explicitly requires the whole Dispatch planner-panel and its automatic
travel/service timing with manual overrides. Implementation proceeds under the
existing implementation/deployment authorization. Detailed spec approval: not
obtained (autonomous run); the user confirmed the UI and timing requirements.

Acceptance criteria:

1. `/mbt/planning` loads the actual `dispatch.js` and `dispatch.css`. The same
   `render`, `renderDriverLane`, `renderLoad`, `renderLoadAssignmentControls`,
   `renderLoadPreview`, and timing/map functions render the entire planner-panel.
   There is no second planner layout or explicit finish-time form.
2. BIN pool cards can be dragged onto a load or an empty driver lane. The shared
   + Load button, truck selector, automatic/fixed start, preview drawer, route map,
   service-time override, undo/redo, save, and confirmation work for BIN loads.
3. Dragging any step moves its entire visit. Required step order is preserved.
   A visit can be removed to the pool; a whole load can move between drivers.
4. Travel and service durations use Dispatch's timing engine. An override persists
   after reload. Subsequent automatic loads inherit the computed finish plus
   Dispatch's travel/switch rules. Empty loads can be saved before assignment.
5. A board save is atomic under the existing date lease and revision/digest fence.
   Replays do not create extra assignment generations. Invalid capacity, overlap,
   stale visit revision, or attempted changes to ordinary loads roll back entirely.
6. Unchanged released BIN work remains released. Changed work requires confirmation
   of its new assignment generation. Completed work cannot be withdrawn.
7. Ordinary Dispatch loads remain visible as schedule context in BIN mode and are
   preserved by the server. Ordinary Dispatch continues loading and saving with
   MBT disabled, without any MBT API request. Two sessions cannot edit the same day.
8. Search/pagination includes all eligible pool visits, and refresh/date navigation
   must not reuse an old date's BIN feed or overwrite a newer local draft.

Failure model: partial board writes and races (transaction/lease tests), altered
ordinary work (adversarial preservation tests), split visit steps (browser and
ordering properties), timing drift (real browser override/reload assertions),
stale or ambiguous saves (shared journal/fence and replay tests), accidental
Dispatch coupling (disabled-MBT browser regression), changing released work
without re-confirmation (generation tests).

Setup: reuse existing isolated Docker/PostgreSQL/Chromium test tooling; no new
runtime or development dependency, no git checkpoint commits, no production test
assignments. Add focused tests and reproducible evidence under server/test and
server/tools. Retain the prior evidence as evidence of the superseded release;
record fresh results and source hashes for this correction. Use a scoped release
overlay, backup and rollback if deployed. Known unrelated baseline failures remain
documented in mbt-bin-planning-evidence.md.

User clarifications during implementation (append-only):

9. Reuse the order pool design; only buttons, tabs and order types differ.
10. Read-only loads have an explicit Read only label and grey background.
11. The mbt-planning-link on Dispatch belongs in the top bar, not the order tabs.

Shared presentation contract: confirmation displays Dispatch's existing uppercase
`CONFIRMED` status. The browser assertion initially assumed title case; it now
checks the exact shared text. Conflict details use Dispatch's existing flat
`reason` field; the empty-draft test checks `missing_interval` there.

Persistence checks also cover calculated per-step arrival/departure, Google route
estimates, truck-switch approach timing, and the shared driver lane order. The
board command accepts only bounded planner metadata and canonical visit intent.
Ordinary-load preservation is checked around each BIN board save. Shared plan
confirmation retains Dispatch's existing normalization of assignment fields, so
post-confirmation saves are compared with that confirmed snapshot.
Moving an automatic load to an empty driver lane follows Dispatch's first-load
timing. If that overlaps the same truck's existing work, the move is rejected;
choosing an available dedicated time allows the whole load to move.
The Dispatch asset contract is versioned `20260927-shared-bin-v2` so deployed
browsers fetch the corrected shared UI. Its existing exact-version test is updated
to that release identifier. Route refresh persistence uses Dispatch's Save Now
action; changing route inputs invalidates the previous estimate until refreshed.

Creating a new plan supports dropping a BIN card into an empty lane and adding a
return. Legacy BIN-only truck containers are mapped to the physical fleet ID;
an alias containing ordinary work cannot be relocated by a BIN save.
Leaving a planner during asynchronous event-stream authentication must not create
an orphaned heartbeat after its HTTP response has closed. A real blocked database
lookup and aborted HTTP request reproduce this navigation race.
BIN manual returns must reach the assigned driver only after whole-day
confirmation, including plans with no BIN visits. Unchanged saves retain release;
changed returns require confirmation again, using Dispatch's existing return jobs.
Their origin is the last BIN step's authoritative yard or customer address. A
Dispatch save cannot change the BIN return destination or its release state.
