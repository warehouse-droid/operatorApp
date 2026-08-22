# MBBS Rate-Card Charging Policy — Executable Acceptance Specification

Status: clarified and approved by the user on 2026-08-14. This document is
append-only for this task.

## Purpose

The selected `DELIVERY_CHARGE_MBBS` rate-card version must contain every rule
that turns completed Dispatch work into an MBBS charge. Distance bands alone
are insufficient: an operator must be able to see how Sales Orders, Transfer
Orders, Purchase Orders, direct pickups, groups, additional drops, and Dispatch
load splits are treated. Unit prices may change over time only through the
existing effective-dated rate-card version lifecycle.

## Failure model

| Failure | Required detector |
|---|---|
| A hidden constant still decides a direct-pickup or PO additional-drop amount | Unit mutation tests and integration tests with non-default policy prices |
| Editing a current price silently changes historical billing | Migration immutability test plus clone/version integration test |
| Preview uses one policy but conversion revalidates against another | Preview/conversion stale-evidence test and persisted policy snapshot assertion |
| A malformed, negative, fractional, overflowing, or non-CAD price enters the rate card | Pure normalization property tests, HTTP validation tests, and database constraints |
| An old active MBBS rate card becomes unusable after migration | Migration backfill test proving both unit prices are exactly CAD 100.00 |
| SO, TO, or PO policy wording differs from calculation behavior | UI contract tests mapped to calculator unit tests for every displayed rule |
| A Driver load split changes a business charge | Existing cross-load planner cases plus policy UI/API contract asserting load splits are ignored |
| Two admins overwrite the same draft policy | Existing expected-revision concurrency test extended to the policy row |
| A non-MBBS rate card receives irrelevant MBBS policy data | Normalization and persistence tests requiring policy only for `DELIVERY_CHARGE_MBBS` cards |

## Executable scenarios

### P1 — Visible policy on the Rate Cards page

Given an administrator opens **MBT Configuration → Rate Cards** and selects a
`DELIVERY_CHARGE_MBBS` version, then a visible **MBBS Charging Policy** section
shows the direct-pickup rate, SO rule, TO rule, PO rule, group behavior,
additional-drop behavior, equal-allocation behavior, and the fact that Dispatch
load splits do not alter charges.

### P2 — Editable unit prices only on an unused draft

Given an unused draft MBBS rate-card version, the administrator may edit:

- **Direct-pickup TO unit price (CAD)**; and
- **PO additional-drop unit price (CAD)**.

The browser sends exact integer cents. Negative, fractional, non-finite, or
unsafe values are rejected. An active, retired, or used version displays the
prices read-only and directs the administrator to clone it.

### P3 — Versioned price changes preserve history

Given an active or used MBBS rate card, when the administrator clones it, the
new draft retains both policy prices and every rule. Editing and activating the
clone creates a new effective-dated policy. The source version and billing
evidence produced with it remain unchanged.

### P4 — Sales Order charging

A standalone SO is charged once using the full distance-band price for that SO.
An explicit SO group is charged once as one business order while retaining all
child SO references. Dispatch load boundaries never change the charge.

### P5 — Transfer Order charging

A replenishment TO is charged once using the full route distance-band price. A
direct-pickup/drop-ship TO is charged once at the selected rate card's
**Direct-pickup TO unit price**, with no distance-band amount added. Dispatch
load boundaries never change either charge.

### P6 — Purchase Order charging

PO split references are the source evidence. PO references sharing one business
leg produce one distance-band charge allocated evenly in exact cents. Each
distinct drop after the first adds the selected rate card's **PO
additional-drop unit price**. An explicit PO group remains one business order
and retains all child references. Dispatch load boundaries never change the
charge.

### P7 — Preview and conversion use the same policy

Every preview exposes the policy schema/version and exact unit prices used in
its calculation steps. Conversion reloads the active policy inside the server
transaction; a missing or changed policy fails closed as stale. Durable billing
evidence snapshots the rule identifiers, unit prices, counts, and resulting
amounts.

### P8 — Existing rate cards preserve current amounts

Migration creates a policy for every existing `DELIVERY_CHARGE_MBBS` version
with direct-pickup and PO additional-drop prices of `10000` CAD minor units.
Reapplying the migration is idempotent and never changes an explicitly edited
draft policy.

## Fixed rule identifiers (schema version 1)

- SO: `per_order_group_as_one`
- Replenishment TO: `full_route_once`
- Direct-pickup TO: `fixed_unit_once`
- PO: `shared_leg_equal_split`
- PO additional drops: `each_distinct_drop_after_first`
- Dispatch load split: `ignored_for_charge`

Schema version 1 makes these rules visible and auditable; this task authorizes
editing the two unit prices, not changing the rule identifiers.

## Append-only PO leg-identity clarification — 2026-08-16

The earlier phrase “Dispatch load splits do not alter charges” applies to
explicit SO/PO groups and to references co-carried on one retained physical
leg. It must not collapse separate ordinary PO/VRMA trips. For an ordinary
PO/VRMA candidate, each distinct immutable Driver `load_id` is a distinct leg;
the non-unique display text (`Load 1`, `Load 2`, and so on) is never an
identity. Multiple PO/VRMA references within that same immutable load may
share and evenly allocate one leg charge. Explicit groups retain their
approved group-as-one behavior.

## Invariants

- All money remains exact CAD integer minor units.
- Existing distance-band editing and lifecycle behavior remain unchanged.
- Billing never trusts browser-supplied policy or money during conversion.
- Rate-card activation fails if an MBBS policy is missing or invalid.
- Used rate-card policy rows are immutable at the database boundary.
- No NetSuite, Dispatch, Driver, or existing billing rows are mutated.
- No runtime dependency is added.
- No production deployment occurs without a separate user request.

## Setup and gauntlet

- Use the existing Node test runner, PostgreSQL rollback fixtures, c8,
  TypeScript, ESLint, property tests, and persisted manual-mutation tooling.
- Add one forward-only migration, focused unit/integration/property/UI tests,
  a source-state helper, and one reproducible gauntlet entry point.
- No new package, external service, or checkpoint commit is required.
