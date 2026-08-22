# MBBS PO/VRMA Vendor-Yard Rate Matrix — Executable Acceptance Specification

Status: approved by the user on 2026-08-15. This document is append-only for
this task.

## Purpose

Purchase Orders and Vendor Return Authorizations use an effective-dated flat
price for a configured physical vendor-yard/MBBS-yard pair. PO travel is
vendor-to-MBBS and VRMA travel is the reverse direction, but both directions
use the same pair price. An absent or ambiguous pair uses the existing MBBS
distance bands.

## Failure model

| Failure | Required detector |
|---|---|
| A spelling variant or weekday schedule row selects a wrong yard price | Canonical-yard unit/property tests and duplicate-schedule integration fixtures |
| PO and reverse VRMA produce different prices for the same pair | Calculator unit and database integration tests |
| A missing matrix row produces zero or a hidden constant | Explicit distance-fallback integration tests |
| A route lookup failure blocks a configured flat rate | Preview integration test with a failing distance adapter |
| Split/group/load layout changes the business charge | Planner and candidate tests covering split, group, mixed PO/VRMA, and multiple loads |
| Allocation loses or creates cents | Property tests over arbitrary safe totals and reference counts |
| Browser-authored money reaches durable billing | Conversion stale/hostile payload tests and immutable snapshot assertions |
| Editing an active/used matrix rewrites history | Migration constraints plus clone/activation integration tests |
| An endpoint override silently chooses the wrong method | UI/API contract tests for flat default and an explicit distance choice |
| Initial production seed silently drops or guesses supplied prices | Golden-table test: 71 supplied rows = 54 mapped + 17 fallback |
| Deployment activates new prices without review | Seed-tool dry-run/apply tests and v3-draft status assertion |

## Executable scenarios

### M1 — Versioned matrix configuration

An unused schema-v2 MBBS draft accepts unique CAD matrix rows keyed by one
validated local vendor yard and one MBBS yard. Active, retired, or used rows
are read-only and cloning preserves every row. Schema-v1 rate cards retain
their original distance-only meaning.

### M2 — Flat PO and reverse VRMA parity

Given a configured vendor-yard/MBBS-yard pair, an inbound PO and outbound VRMA
use the same flat base amount. Distance lookup is optional information and a
failed route provider does not block the flat calculation.

### M3 — Distance fallback

If no unique configured pair exists, the completed route uses the selected
MBBS distance band exactly as before. No fuzzy or partial name match is
permitted.

### M4 — Shared leg, groups, and extra stops

PO and VRMA references sharing one retained business leg create one charge.
The configured flat or distance base is charged once, each distinct stop after
the base pickup/drop pair adds the versioned additional-stop price, and the
final total is allocated evenly in exact cents. PO split references and group
children remain audit evidence. Dispatch load splits never alter the amount.

### M5 — Endpoint override choice

When retained actual endpoints differ from a configured canonical pair, the
preview exposes server-calculated flat and distance choices and defaults to
flat. The billing user may choose distance without a per-row reason. Conversion
recalculates the selected method and snapshots it; the existing batch audit
reason remains required.

### M6 — Visible calculation evidence

Rate-card configuration displays the matrix and every fixed rule. Billing
results display vendor yard, MBBS yard, pricing source, base amount, distance
when available, additional stops, allocation, selected override method, and
final charge. Money remains editable through the existing adjustment/final
fields.

### M7 — Approved initial mapping

The supplied 71-row price list resolves 54 rows to current master data:

- Beaver Valley Stone — Maple;
- BWS — Uxbridge and Woodbridge;
- CFC — Canada Fastening, Mississauga;
- Oakville — Oakville Stone, Mississauga;
- PERMACON — Bolton, Cambridge, and Milton;
- Techo-Bloc — Ayr and Vaughan; and
- Unilock Ltd — Ayr, Georgetown, Gormley, and Pickering.

Destination labels `12441`, `2967`, `3445`, and `150` map directly; `BS` maps
to `150`. The exact supplied CAD amounts are retained. The 17 Browns-Sudbury,
Crupi-Markham/Scarborough, Draglam-Vaughan, Permacon-Woodstock,
Unilock-Barrie, and Voyage-Scarborough rows have no current physical vendor
yard and therefore remain distance-band fallbacks.

### M8 — Reviewed v3 draft only

The audited seed operation clones the active `DELIVERY_CHARGE_MBBS` v2 into a
schema-v2 v3 draft effective 2026-01-01 Toronto time, maps Canada Fastening to
the existing CFC local vendor, imports 54 matrix rows, reports 17 fallbacks,
and never activates the draft. Once separately activated, it applies to
unconverted 2026 work; existing converted evidence never changes.

## Invariants and setup

- All money is exact CAD integer minor units and all products/sums remain safe
  integers.
- Candidate identifiers, yard identities, rates, distances, and allocations
  are server-owned and revalidated during conversion.
- No NetSuite write, outbox work, Dispatch mutation, Driver PWA mutation, or
  historical billing mutation is introduced.
- Use the existing Node test runner, PostgreSQL rollback fixtures, Playwright,
  c8, TypeScript, ESLint, property tests, and persisted manual mutation tools.
- Add no dependency and make no checkpoint commit.
- Run database tests in isolated containers and tear them down after the final
  gauntlet.

## Append-only clarification — 2026-08-16 latest supplied table

### M9 — Canonical `150` source labels

The latest user-supplied 71-row table replaces the two legacy `BS` display
labels with `150`. The canonical seed, draft, configuration UI, and retained
rate evidence must therefore contain these exact rows:

- `Permacon - Cambridge to 150` — CAD 550; and
- `Unilock - Georgetown to 150` — CAD 400.

No canonical seeded rate name or display name may end in `to BS`. This naming
clarification does not change any amount, physical destination, vendor-yard
identity, the 71 supplied-row total, the 54 exact mappings, or the 17 explicit
distance-band fallbacks. The reviewed v3 must remain a draft while the active
v2 continues pricing production billing.

A one-time reconciliation may update the already-created reviewed v3 only when
it is still an unused draft, belongs to the same active v2 lineage, has exactly
the expected 54-row pre-clarification graph, and retains the expected revision.
The reconciliation must be atomic, audited, idempotently reject an already
corrected or concurrently edited graph, and must never activate either version.

## Append-only clarification — 2026-08-16 physical PO leg identity

### M10 — A specific Driver load is a specific ordinary PO/VRMA leg

For ordinary, non-grouped PO/VRMA work, the immutable Driver `load_id` is part
of the business-leg identity. The human label is display evidence only:
`Load 1` for one driver and `Load 1` for another driver are different legs.
Two distinct retained `load_id` values must never be merged merely because
their vendor origin, MBBS destination, displayed load number, source Blanket
PO, or rate-card pair is the same.

Within one immutable Driver load, multiple PO/VRMA split references on the
same retained route still share one base charge and receive exact-cent equal
allocation. An authoritative explicit PO group remains one business order and
retains its child references. Missing legacy load identity must remain
fail-safe and must not cause identified loads to merge with it.

The production regression fixture is plan `233` on `2026-08-13`:

- T6 `Load 1` / `SN1398117`;
- T7 `Load 1` / `SN1397703`;
- T6 `Load 3` / `SN1397953`; and
- T7 `Load 3` / `SN1397952`.

All four travel from Unilock Ayr to yard `12441`, but they have four distinct
immutable load, pickup-visit, and drop-visit identities. They therefore create
four independent vendor-route base charges, not one four-way allocation.
