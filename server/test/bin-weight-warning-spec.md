# Advisory truck weight limits in MBT Planning

The user explicitly requested that exceeding a truck's weight capacity be a soft
warning, not a save block. This replaces the earlier hard truck-weight rule.
The reported trip is SOB123353 (17,350 lb) on BINTEST (48,000 lb). The existing
BIN00002X-1C collection in Load 2 has no measured cargo weight and is estimated
using the newly configured 14YD payload limit, about 60,000 lb. A whole-plan
capacity check currently blocks saving the otherwise lighter Load 4.

1. Saving, assigning and confirming BIN work may exceed truck weight capacity.
   Return a warning with truck, load, order/action, calculated onboard weight,
   configured capacity and excess. Unknown collection weight is explicitly an
   estimate based on the bin payload limit.
2. Render warnings in the existing load warnings UI and retain them after reload.
   Removing a visit must not leave its warning on the previous load. Warn from
   peak simultaneous onboard weight, not the sum of sequential trips.
3. Overweight transport remains selectable and assignable to an otherwise
   compatible BIN truck. Keep active equipment/driver, supported bin size,
   physical slot count, valid movement sequence, custody, reservations, source
   quantity and source-window protections. This change concerns truck weight;
   the separate bin payload limit and missing-weight requirements remain.
4. Read-only planning still opens when a route has another validation problem;
   advisory reads must not turn a correctable invalid plan into an unreadable UI.
5. Preserve completed Driver history and existing customer plans. Do not save the
   user's browser draft on their behalf. Use disposable fixtures to verify saving
   and confirmation of overweight routes and persistent browser warnings.

Update the old weight-block assertions to the newly approved warning behavior;
retain their physical-slot and malformed-route assertions. Add no dependencies.
Use the bounded disposable runner, fresh affected regression runs in both orders,
property/mutation checks, static checks and coverage, then deploy a narrow overlay.
Remove every disposable resource and artifact and retain only concise evidence
and operational release/rollback records.

Verification clarification: the pre-existing cargo-routing regression also encoded
the old hard truck-weight rule. Replace only that truck-weight expectation with
successful assignment and an exact warning; retain its oversized bin-payload
rejection. Explicit browser removal/save/reload checks cover stale warnings.

Verification setup clarification: the existing transport offline fixture assumes
06:00 UTC asset registration precedes a real-time manifest. After Toronto
midnight this is false, and the unchanged live baseline reproduces the failure.
Normalize only that synthetic fixture's clock before planning, following the
existing Driver offline fixture pattern. Preserve all chronology/application/replay
assertions and rerun the complete affected verification.
