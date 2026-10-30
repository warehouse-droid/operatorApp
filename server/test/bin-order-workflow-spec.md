# BIN order workflow specification

Approved scope: the user approved the conversational implementation plan and
its workflow diagrams, then corrected references to the BIN prefix. This file
makes those criteria executable. Tier 3: custody, concurrent assignments,
public driver contracts, offline retries and existing billing ownership.

## References

- One globally unique, immutable, minimum-five-digit number per rental/service
  line. Sequence gaps are acceptable; reuse or renumbering is not.
- Rental 1 initial delivery: BIN00001D.
- Final pickup: BIN00001C; dump: BIN00001C-DP; yard return: BIN00001-R.
- Exchange 1 parent: BIN00001X-1; delivery: BIN00001X-1D; pickup:
  BIN00001X-1C; dump: BIN00001X-1DP.
- Consistent default for an exchange's yard return: BIN00001X-1R.
- A collection feeding rental 2 uses that rental's existing delivery reference
  BIN00002D. Linking work does not allocate another rental number.
- Backfilled readable references must not change historical visit IDs, stop
  IDs, immutable evidence, or issued offline snapshot hashes.

## Executable acceptance cases

1. Delivery shows its selected physical bin and last confirmed source. Planned
   predecessors show a clearly identified future source. A bin already aboard
   the assigned truck does not acquire a duplicate physical pickup.
2. Every rental has initial Delivery and final Collection. Each Exchange owns
   separately schedulable delivery and collection parts.
3. Collection includes pickup and dump, followed by an approved-yard return or
   one linked Delivery (initial or exchange) of the same physical bin and exact
   target bin type. Required scan/photo/receipt evidence remains enforced.
4. Same-bin collection-first: pickup, dump, deliver to the original site on the
   same America/Toronto calendar day. Dump is required before delivery.
5. Different-bin collection-first: replacement delivery follows confirmed
   pickup, on the same local day; the old bin's dump/onward work remains open.
6. Delivery-first: old-bin pickup follows replacement delivery, even days later.
   Another exchange may start while older collections remain pending. Every
   collection retains its original physical asset.
7. Final Collection picks up the current asset; older obligations survive and
   prevent operational closure until all recovery routes finish.
8. Linking a Collection to a Delivery creates one physical destination action,
   with explicit prerequisite completion rather than a cyclic order dependency.
9. Planning checks source, type, capacity, chronological feasibility, custody,
   reservations and same-day promises; execution checks actual prerequisites.
   A late real-world completion is recorded and flagged instead of discarded.
10. Changing trucks requires recorded custody. Stale plans, mismatched bins,
    circular reuse, simultaneous exclusive claims and silent redirection fail.
11. Duplicate and late offline events cannot double-move or double-charge bins.
    Cross-device prerequisites must be durable before dependent execution.
12. Front Desk and BIN Planning expose human references, exchange sequence,
    separate schedules, dump/destination choices, current and pending bins.
    Driver list and job details show the action's bin and actual address.
13. Existing legacy visits remain compatible; new/unissued work can use the
    new workflow, and issued work is never silently rewritten.
14. Split execution parts preserve the existing parent billing owner and rate
    calculations. Shared movements generate no duplicate billable service.

## Failure model and verification

- Sequence races, double bookings and double events: real transaction race and
  idempotency tests, unique constraints, atomic rollback checks.
- Wrong bin or location, skipped dump, premature closure: realistic
  driver/planning integration scenarios and property invariants.
- Stale offline snapshots and handoffs: old-schema contract regression and
  replay/custody cases.
- Changed route or hidden outstanding work: browser tests using the actual
  Front Desk, planner and driver projections.
- Migration/backfill and rollback compatibility: disposable database upgrade
  checks; no production database used for tests.
- Regression baseline, lint/types, changed-line coverage, property tests,
  3–5 deliberate mutants and adversarial scenarios. Record exact results and
  skipped layers with reasons in the evidence artifact.

## Setup and preservation

Use existing Node, Playwright, TypeScript, ESLint, c8 and fast-check toolchains.
No new runtime or development dependencies. Capture the current dirty runtime
source as a baseline; preserve unrelated changes and avoid a broad checkout or
commit. Persist tests, reproduction tools and evidence in established test,
tools and test-artifacts directories.

All test containers use the standard isolated Compose setup, mbbs-tests.slice,
bounded memory/CPU/PIDs/tmpfs and disposable labels. Register teardown before
creation; use down --volumes --remove-orphans and verify docker ps, docker ps -a,
project networks/volumes, and production health on every exit.

No production mutation or deployment is needed to establish the implementation
and evidence. A release must preserve the live runtime and apply only the
reviewable feature changes and additive migrations.

## Clarifications from implementation review

These extend cases 1, 7, 8, 10 and 13 without changing their behavior:

15. A linked receiving Delivery retains the selected physical bin before that
    bin is collected, and labels its future source “After dumping”. Its source
    Collection keeps its asset reservation until the shared Delivery finishes.
16. A legacy driver job completing after upgrade updates the rental's current
    bin from committed physical state without rewriting its frozen instructions.
17. Retargeting a draft final Collection or a shared onward Delivery must fail
    atomically if either affected destination already has assigned or issued
    work. Existing references, assets and instructions remain intact.

## Approved bin re-selection extension (2026-10-22)

The user approved implementation of the follow-up plan. These cases extend 13
and 17 for the dedicated bin-selection operation; full workflow editing keeps
its existing restrictions.

18. Dispatch can change the delivery/replacement bin in the pool, on a draft
    load, or after release/travel, until the server records the first BIN stop
    starting anywhere in that order. Front Desk remains the creator of orders.
19. Linked Collection → Dump → Delivery and same-bin exchanges keep their
    physical bin. Independent replacement selection does not change the old
    collection's identity. No new exchange or billable order is created.
20. Re-selection preserves order/visit identities, evidence, schedules and
    load order. It updates future dependent collections and onward deliveries
    atomically, including other plan dates. Every affected plan requires its
    own edit lease and revision/digest; every visit and bin has a revision fence.
21. Source location and mandatory pickup reflect the newly selected bin. A
    bin aboard the assigned truck needs no duplicate pickup. Capacity, custody,
    type, active reservations and workflow dependencies are revalidated.
22. Released affected assignments are automatically republished with a new
    generation; affected drafts and unrelated drafts stay unreleased. Old
    driver jobs are withdrawn; stale offline evidence follows review.
23. Start versus selection and competing selections serialize: exactly one
    wins. Failures roll back reservations, assignments, plans and audit; an
    identical retry returns the first result without another generation.
24. Dispatch and Driver show the action reference and its physical bin on each
    stop, including legacy assignments. Display correction never renames an
    immutable execution identity or rewrites completed evidence.
25. UI uses “Plan delivery/exchange/collection” for operational configuration
    and “Change assigned bin” for resource selection, with the actual lock
    reason displayed. Five-digit numbering and all three PDF routes remain.

Additional failure checks: missing or foreign date leases, stale source state,
cross-rental linked chains, withdrawn driver generations, unrelated draft
publication, source changes invalidating route timings, and started child
steps whose parent has not yet recorded a start. Use the existing bounded
disposable runner; add no dependencies or commits. Deploy only the feature
over the current live runtime after validation, retaining rollback data.

## Order-owned material and receiving-order clarification (2026-10-23)

The user requires the order to define dump material and the same physical bin
to continue to an existing receiving order. This narrow correction uses the
existing test tools and bounded runner, adds no dependencies or migrations,
and preserves the prior release and concurrent application changes.

26. Collection/exchange planning displays the order's material read-only and
    selects only a dump site accepting that material. No material selector or
    client-supplied replacement material can change the order's definition.
27. Resolve both legacy material IDs and Front Desk content/pricing evidence.
    Exchange collection uses the old bin's ordered contents, independently of
    the replacement's contents. Missing, inactive or ambiguous material mapping
    blocks planning with an actionable message; never guess another material.
28. Receiving delivery asks for an existing order and shows its BIN reference
    and customer. Only eligible receiving orders matching the collected bin's
    fixed type appear; a forged incompatible target still fails atomically.
29. Retain existing order IDs, same-bin linkage, dump evidence requirements,
    issued instructions and all three exchange routes. The correction updates
    planning choices without rewriting already issued work or pricing.

Failure checks: stale clients posting a different material, unrelated accepted
materials offered by the same dump, inactive/ambiguous catalog mappings, old
versus replacement contents on exchange, and mismatched receiving-order types.
Use failing integration/browser tests, the full affected suite, baseline-aware
static checks, changed-line coverage, and deliberate mutations. Separate spec
approval is not requested for these direct user corrections; record the stated
acceptance criteria and actual validation limits in the evidence.

30. An Exchange replacement may have different ordered contents and bin size.
    If its type differs from the collected physical bin, only delivery-first
    with a different physical bin is allowed. The UI disables same-bin reuse
    and collection-first; server validation rejects either forged alternative.
    The old bin retains its own size and ordered dump material, and its pickup
    depends on completion of the replacement delivery. Same-size routes remain.

31. When an unissued final collection is retargeted to a replacement with new
    contents, its dump material follows the current order. Its chosen dump must
    accept those contents; otherwise exchange configuration fails atomically
    until Dispatch selects an accepting dump for that final collection. Issued
    final collections retain the existing lock and instructions.

32. A later replacement order's incoming material takes precedence over a
    legacy final collection's original material ID. Resolve that current
    definition without rewriting the immutable original order snapshot.


## Explicit collection and overdue reminder — 2026-10-23

Spec approval: not obtained (autonomous run); implementing the user’s correction.
Tier 3: public commands, serialized writes and production draft remediation.
No dependencies, installs or commits. Use existing bounded disposable runner.

33. Initial quote conversion (legacy and multiple bins), and a confirmed add-bin
    request create Delivery only. Expected return dates remain on each service
    line; expiry and read operations never create a Collection order.
34. Front Desk Collect bin requires a completed placement, creates exactly one C
    root and its pickup/return steps, and records who requested it. Replay and
    competing requests must not duplicate orders; stale/unauthorized/invalid
    requests roll back. A later request reschedules the same unissued C order.
35. Expected-date extensions and exchanges work without a C root. An explicit
    collection follows the latest replacement and its ordered material/size.
    Existing requested/unissued returns can still be amended, while issued work
    retains its existing protections. Initial delivery still accepts a physical
    bin assignment without a dependent C order.
36. Front Desk shows an overdue list across customers using the expected return
    timestamp. Only open delivered bins still awaiting collection qualify.
    Pending explicit collections are identified; closed/cancelled/undelivered
    lines and bins already picked up are excluded. An extension into the future
    clears the reminder. The list opens the relevant contract and refreshes.
37. Withdraw only untouched automatically generated C drafts with no explicit
    request, assignment, issued instructions, activity or configuration. Preserve
    their audit/rollback record, due date and delivery order. Ineligible records
    and all production billing/history remain untouched. Rehearse the exact
    repair eligibility, rollback and repeat execution on disposable data.

Failure model: duplicate requests (race + idempotency tests), half-created visits
(transaction rollback), false overdue alerts (boundary/property tests), stale
collection asset/material (replacement integration tests), hidden issued work
(legacy protections + repair eligibility tests), cross-customer/role leakage
(authenticated API checks), UI stale dates (browser refresh/extension tests).
Prior tests that expected automatic returns must be explicitly updated to the
new behavior; legacy seam tests retain legacy fixtures to test issued history.

38. Front Desk timeline displays one logical Delivery/Collection/Exchange order;
    execution parts remain accessible to Dispatch without duplicate D entries.
39. Front Desk may change initial delivery times until any part is assigned to a
    Dispatch load. Dispatch can edit requested windows from order cards, including
    assigned work before execution; revision fences, leases, same-day route rules
    and released instruction republishing remain enforced.
40. Before planning, Front Desk may preview and confirm a bin size/material
    change against the configured rate card. Preserve the rental/D identity,
    compute the difference from the accepted price (including negative credit),
    and never overwrite prior financial evidence or duplicate the charge.
    A changed size clears an incompatible prepared physical-bin selection.
41. Soil/concrete/asphalt fixed dump charges are equal and due upfront; material
    changes among them add no price. Garbage dump charges use DumpGarbage per
    tonne after completed collection weight evidence, separate from the upfront
    price adjustment. Garbage-to-soil can add a charge; soil-to-14YD-garbage can
    create a credit. Current rate card data, not a hardcoded amount, sets prices.

Rate confirmation received 2026-10-23: Soil, Concrete and Asphalt are $300/bin;
DumpGarbage remains $120/tonne. Correct live rates through versioned commands,
preserving accepted prices and tariff history. Add hostile calendar-input checks
and a failed-migration rollback rehearsal with existing accepted price rows.


## 2026-10-23 user correction: order authority, pool and search

Autonomous Tier 3 continuation; spec approval not separately obtained. No new dependencies,
commits, production test data or external payment actions. Use the existing bounded disposable
runner, clean every owned test resource, and overlay only the manifest files onto the current
live image. Pricing configuration uses audited versions and the user's deposit amount once supplied.

42. Front Desk may change an unplanned delivery window with an omitted, empty or supplied reason.
    Preserve revision/idempotency fences and an audit entry; planned/started deliveries still reject.
43. This supersedes the earlier criterion allowing Dispatch window changes: Dispatch cannot amend
    requested windows through the time-window API, workflow setup, or onward-delivery linking.
    All requested windows displayed in Dispatch are read-only. Workflow construction uses the
    existing Front Desk order windows; existing child windows are retained when reconfiguring routes.
44. Order-pool cards have no action buttons or selectors and fit their container at ordinary desktop
    and narrow widths, including long customer names/addresses. Selected-order actions below search
    offer route setup, Change bin and Details as appropriate. No Assign to selected load button;
    drag/drop remains the assignment mechanism. Completed/cancelled work has no editing actions.
45. Nonempty BIN search includes unplanned, planned and completed work across plan dates. It returns
    one visible card per workflow part (or unconfigured order), stable readable references, actual
    status and current assignment metadata. Withdrawn assignments must not appear as active plans.
    Clicking a planned/completed result opens its plan date and load using shared Dispatch navigation.
    Empty search keeps only available unassigned work. Search races cannot show another term/date's feed.
46. Garbage bin changes require the user's configured active deposit; select the incoming bin item's
    effective rate version, then the legacy contract version only as fallback. Apply the most specific
    matching rule and reject ambiguous equal-specificity rules. Preserve signed charges/credits and
    fixed Soil/Concrete/Asphalt $300 plus deferred DumpGarbage $120/tonne. Never invent a deposit.

Failure model: unauthorized window changes (direct API and nested workflow payload tests), wrong or
ambiguous deposit (real item-rate tests and signed-delta properties), lost customer dates (DB equality
and rollback checks), duplicate/historical search assignments (cross-date/withdrawal/pagination tests),
uneditable completed jobs (DOM and API guards), stale search navigation (browser checks), overflow
(browser bounding boxes), shared app regression (existing Dispatch/BIN suites and narrow live overlay).

47. User confirmed a new CAD500 garbage deposit for each bin size. Version both active BIN item rate cards, preserving rental/extension rates. Deposit graph round-trips, correction replays once and rolls back atomically. Existing accepted charges are not rewritten.

48. Legacy tentative successors blocked behind unfinished work stay out of search. Available legacy
    visits, planned work and completed work remain searchable. This intentionally changes older
    search tests that expected assigned/completed work to be hidden; availability checks use an
    empty search. A stale visit assignment whose load is missing cannot offer plan/load navigation.

49. After saving a delivery window or confirming a bin price change, Front Desk keeps the dialog
    open and its submit button disabled until the refreshed contract/line revisions arrive. The
    next action must use the new window and revision, even when the timeline response is delayed.
    This addresses a real race exposed by the reverse-order browser run.

50. The deposit correction supports both item-bound rate cards and the live legacy layout where
    the BIN item is bound through rental components. Resolve one BIN item per version, preserve
    the existing binding, rental and extension components, and retain atomic rollback/replay.
