# Grouped Link TO and Operator planned transfers

Spec approval: not obtained (autonomous run). User authorized fixing the grouped
Link TO failure, overlapping action button, and missing linked TO in Planned.
Reported case: GOM-6531-6537 / TOB01103. Existing deployment authorization applies.
Tier 3: allocation integrity and execution guards require adversarial evidence.

## Acceptance criteria

1. An active global SO group created on one date resolves on another plan date,
   even when it is absent from that date's snapshot. Match and link use current
   source lines, preserve distinct member line identities, and enforce available
   quantities and target signatures. Retired definitions cannot be resurrected
   through stale snapshots. Ordinary SOs and splits retain their behavior.
2. A completed, received source CO does not prevent linking a fresh TO for a
   still-unstarted SO delivery. The completed CO and original driver evidence
   remain unchanged. A legacy shared pickup is exempted only when the exact saved
   route, immutable CO correction proof, yard, chronology, and complete reference
   set prove it was CO cargo. Genuine SO execution, unreceived/active CO work,
   ambiguous or missing evidence, unrelated shared cargo, and started selected
   lines remain protected. Existing transaction locks and stale-command checks
   continue to apply.
3. A direct TO linked to an assigned SO/group appears in Operator Planned at its
   own source yard, inheriting the confirmed plan's date/truck/load/parking.
   The card, detail, date/truck filters, notifications and load selectors agree.
   This is an Operator projection; independent Dispatch planning flags and
   quantities are unchanged. Draft/cancelled plans, cancelled links, unplanned
   targets and yard-replenishment links do not inherit the SO's assignment.
4. Selected-order actions wrap within the planner panel, including long grouped
   references and the full action set. Link TO and adjacent controls remain
   separate and clickable at narrow and desktop widths. Modal matching controls
   also fit. The stylesheet URL advances so existing clients receive the fix.
5. No new business link is guessed or committed on the user's behalf. The real
   reported target is verified with read-only match/preview after deployment;
   link mutations and completed-CO preservation run against an isolated DB.

## Failure model and verification

- Wrong identity or stale group: real PostgreSQL resolution, retired/stale
  signature rejection, generated member/quantity cases.
- Mistaken customer-execution exemption: exact-identity adversarial tests and
  deliberate mutations; preserve real operator/driver blockers.
- Phantom or stale Operator assignment: real list/detail/filter/load tests for
  confirmed, moved, removed and cancelled route/link states.
- Allocation races: existing allocation and operator-lock concurrency tests,
  repeated command/idempotency checks. No lock protocol change is intended.
- UI collision or stale assets: Chromium geometry/click tests using production
  rendering/CSS and a fresh asset URL.
- Regressions: focused packet, changed-line coverage, manual mutation,
  randomized test order, static checks, and full-suite comparison to the last
  verified identical starting tree (2,844 tests, 19 existing failures).

## Setup and release

Use the existing Docker Node/PostgreSQL/Playwright tools. No new dependencies,
external messages, git initialization or commits. Work in an isolated copy of
the previously verified CO release, then apply only this patch to the shared
workspace. Preserve concurrent field-sales work. Persist the spec, fixtures,
tests, reproducible checks and evidence report. Overlay the scoped patch on each
captured running image; verify exact candidates, configuration, health and asset
hashes, with rollback images. No database migration or operational data rewrite
is intended; any required exception must be appended here before implementation.

## Evidence-based clarification 1

Migration 191 deliberately records CO arrival in `details.driverCompletion*`
without setting `received_at`. A verified completed driver drop, or an existing
receipt, is the terminal arrival evidence in criterion 2. A `completed` label
alone is insufficient. The adversarial test therefore removes both receipt and
driver-completion identity, rather than incorrectly treating a missing receipt
timestamp as proof that no arrival happened.

The new projection also exposed an existing Date/string mismatch in dependency
unplanning. Normalize dates only for that comparison so removing an assignment
clears its dependency metadata. Database date assertions serialize Date objects
as the API does; the expected calendar date is unchanged.

## User-requested extension 2: grouped actions and address override

Audit every visible grouped action for literal-reference handling. Link PO must
share canonical child-line resolution across dates. Group address, pickup override,
expected date and time edits must update each canonical SO/PO/TO child atomically,
including an unmaterialized SO split without changing its parent or sibling.
Retired/missing/closed children or invalid dates reject the entire edit; a stale
client must not supply replacement membership. Persist the group/child projections
so pool refresh, autosave reconciliation and driver routing agree. Replacing or
clearing an override applies to every member; PO vendor pickup remains separate.
The PO Set Yard action must also update its real member POs atomically. CO cargo
identity remains separate from the customer orders it transports; unsupported
CO group detail mutations must return an explicit error rather than touch SOs.
No bulk changes to existing groups are part of this release.

## User-requested audit finding 3: grouped Split

The existing Split implementation copies a group's child metadata while naming
the group as a nonexistent source SO/TO. The safe supported workflow is to ungroup,
split the intended child with its own quantities, then regroup. Disable grouped
Split with that explanation and reject equivalent API/legacy-save attempts before
any write. Existing ordinary/split/CO packing and completion identity stay intact.

## Audit finding 4: Consolidate Pick

The planner's legacy Consolidate Pick draft uses only `items[0]`; applying it to
an aggregate group would lose member/item intent. Like Split, require ungrouping
and selecting the child order before this draft action. Preserve group identity
for route placement, child SO identity for customer execution, and CO identity
for the physical yard transfer. No automatic stock-transfer draft is created.

## Final-review invariant 5: retain current cargo during detail edits

Updating dispatch details must aggregate the freshly loaded child items and keep
CO routing inherited by those children. It must not restore cached group totals
or remove inherited CO metadata. The underlying CO manifest and execution records
remain unchanged. Regression: change the first child's quantity from 4 to 8, edit
its group address, and retain a 14-unit group plus both children's 2967 CO routing.

The same route check is applied to PO groups: regenerate the existing PO dropoff
projection after edits so Driver navigation uses the override, and clearing it
returns to the mapped destination. Vendor pickup remains unchanged by a delivery
address edit. This retains the application's existing PO line/destination rules.

Driver navigation must prefer the current PO dropoff address over a stored stop
address or yard default. Global-definition reconciliation must carry the current
dropoffs and residual allocation projection into a stale plan; no driver event
or completed job is rewritten. A partially allocated 20-unit PO group must keep
16 units on its PO route after both override and clearing.

Dispatch map navigation uses the same current PO dropoff address as Driver,
including when an old stored stop address remains after clearing an override.
