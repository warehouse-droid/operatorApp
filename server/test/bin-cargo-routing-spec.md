# BIN cargo routing — 2026-10-23

Spec approval: not obtained (autonomous run). The user authorized implementation,
including existing Custom Orders and one-off cargo, with one custom order per bin.
Tier 3: route writes, driver execution and exclusive Custom Order claims.

1. Details for an aggregate delivery reads its purchased materials (including
   Gravel, quantity and weight) from the order. Each material needs a pickup at
   an active yard (including 3445, 2967 and 150) or a custom address before assignment.
2. Dispatch can add materials without a purchased aggregate, or one custom
   movement: an existing open Custom Order, or a one-off description and weight.
   Multiple materials are allowed. Mixing materials and custom cargo, or two
   custom orders, is rejected by the server. Purchased materials cannot be removed,
   renamed, repriced or replaced by Dispatch.
3. Each pickup precedes its drop. Empty-bin pickup precedes cargo pickup. Cargo
   travels in that bin. Separate cargo drops precede final bin placement/return;
   same-destination cargo is delivered at that final stop. Same-yard operations
   have zero travel between them. Collection cargo starts only after dumping.
4. Save is revision-fenced, idempotent and transactional. Assigned but unstarted
   visits require the current plan lease/revision and a verified route fitting
   the load. Started/completed work is immutable. Reconfiguration and bin changes
   retain cargo. Requested customer time windows and financial snapshots do not change.
5. Existing Custom Orders are exclusively claimed across BIN and ordinary
   Dispatch. A stale order, closed order, system-managed order, transit order or
   independently planned order cannot be linked. While linked, ordinary edits,
   cancellation and assignment are blocked. Removing unstarted cargo releases it.
   Driver completion completes the custom order once at its drop, not its pickup.
6. Driver stops show cargo details and physical BIN identity, require existing
   scan/photo evidence and obey predecessor checks. Cargo pickup/drop retains
   physical custody aboard the truck. Capacity counts bin tare plus actual cargo
   weight, rejecting excess bin payload and truck weight.
7. Details supports all choices, route preview, validation, save/error/retry and
   read-only started work. Pool cards and toolbar remain as previously requested.

Failure model: stale concurrent saves/claims (database race tests), orphan claims
or partial republishing (transaction rollback tests), lost/duplicated cargo or
wrong step order (integration + properties), hostile addresses/modes/weights
(adversarial validation), overweight routes (capacity integration), changed driver
instructions after start (driver integration), mixed workspace deployment
(captured live image plus narrow three-way overlay and exact source hashes).

Setup: use existing Node test runner, Playwright, fast-check, c8, TypeScript and
ESLint in bounded disposable containers; add no dependencies and create no git
commits. Add a nullable independent cargo-plan table and partial unique custom
claim index; no rewriting of order/pricing/customer data. Test migration rollback
in disposable databases. Retain concise evidence; delete all test artifacts.

Clarification: “mixed materials” means multiple different materials in the same
BIN; Front Desk already supports multiple aggregate lines. All those purchased
lines remain available together. The exclusive alternative is one custom order.
Live bin types have no configured maximum payload. Enforce a bin limit when one
is configured; always count actual cargo weight against the truck limit.

2026-10-23 follow-up: the user found the controls and requested moving them to
Plan Delivery. This supersedes the Details location in criteria 1 and 7.

8. Plan Delivery contains cargo/material inputs and the route preview. One save
   stores the selected bin workflow and cargo route transactionally. Details
   presents steps/history and has no cargo editing controls.
9. Front Desk materials are mandatory: every material requires a pickup, and
   Dispatch cannot select No cargo or a custom order. Both browser submission
   and the workflow API reject missing/incomplete routes without partial writes.
10. Saved routes remain editable through Plan Delivery. Assigned but unstarted
    work uses the existing lease/revision checks for cargo changes while workflow
    controls stay locked. Started work stays immutable. Plain BIN deliveries
    still permit no cargo, manual materials or one custom order.
11. The preview follows the selected bin source and return destination. Existing
    route steps and purchased quantities survive reopening. Stale saves and
    downstream failures roll back the combined change; retries remain idempotent.

Follow-up setup: reuse existing tooling, no dependencies/migrations/commits.
Capture a new live/workspace baseline and deploy only changed cargo/planning
files. Verify the real browser flow, API, rollback, concurrency and affected
workflow/driver regressions using the same disposable test policy.
