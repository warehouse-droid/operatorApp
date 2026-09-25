# Direct TO pickup at the SO transit yard

Scope: SOA08838 already has a correct CO from 150 to 3445 and a direct link to
TOB01102 for 52.25 SQFT / 5 LYR of Trevista at 3445. The user confirmed the CO is
correct and withdrew the operator-screen issue. Keep the CO and packing as-is.

Acceptance criteria:

1. At a pickup matching the SO's effective source yard, show the remaining SO
   cargo plus direct TO cargo collected there, exactly once. Include TOB01102
   and its SO reference in the pickup detail, and retain all SO-only rows.
2. Partial allocations and multiple TOs conserve quantity across pickup yards.
   A TO collected elsewhere stays absent from this yard. Equivalent sublocation
   labels resolve to the same yard.
3. An order fully allocated to a TO at the same yard still requires a pickup,
   with the correct physical footprint and weight in browser and server routing.
4. Drop details, PO pickups, service-item filtering, nonlinked orders, and
   existing separate-yard direct pickups retain their current behavior.
5. Empty residual SO cargo does not produce a misleading SO header. TO headers
   remain HTML escaped. Rendering and projection do not mutate their input.
6. Replay the actual SOA08838 plan in a read-only database transaction, checking
   quantity, pickup detail, drop quantity, and the active CO. No database repair
   or NetSuite writes are needed.

Verification: Tier 2 of the already-invoked old-coder workflow. Run the regression
before implementation, focused adjacent suites, quantity properties, changed-line
coverage, manual mutations, syntax/lint/types and the full suite against its
recorded baseline. Existing failures must not increase. Record final source
hashes and reproduce the checks through one persisted gauntlet entry point.

Setup: use the installed Docker Node/test image and isolated PostgreSQL test
runner; add only local test/support/tool/evidence files. No dependencies, package
changes, commits, or changes to unrelated working-tree files. Build a scoped app
image from the current production image, run candidate smoke/live read checks,
and deploy with the existing rollback/configuration guards.

Spec approval: not obtained (autonomous run). This implements the user's reported
pickup defect and explicit instruction to ignore the operator issue; no separate
spec-review approval is claimed.

## Subsequent user correction

The user reinstated the operator issue: the CO should take over the original
SO's packing, with the original SO lines released automatically. The question
whether to clear the SO packing or move it to the CO is pending. The pickup fix
is independent; do not mutate source/CO packing before that answer.

The user subsequently selected **Clear SO packing; pack on the CO**. This resolves
the pending decision and supersedes the original instruction to keep SO packing.
The approved handoff and guarded current-order repair are specified separately
in `co-source-packing-handoff-spec.md`; existing CO packing remains intact.
