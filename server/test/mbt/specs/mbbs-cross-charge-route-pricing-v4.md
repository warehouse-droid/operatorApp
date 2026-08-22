# MBBS cross-charge route pricing v4 executable specification

Status: implementation contract. The operator supplied the examples and asked
for autonomous implementation on 2026-08-20; separate pre-code approval was
therefore not requested.

## Invariants

1. Money is calculated in integer CAD cents from integer provider metres.
2. The quoted 30–50 km band is a flat CAD 285.00, including both quoted
   boundary semantics already owned by the rate card.
3. The over-75 km band is a configurable base-plus-excess band. It charges CAD
   385.00 for the first 75,000 metres, then CAD 7.00 per kilometre only for
   metres above 75,000, rounded once to the nearest cent. Thus 75 km is CAD
   385.00 and 80 km is CAD 420.00.
4. Existing `per_km` bands without base/excess fields retain their historical
   full-distance meaning. A partial base/excess configuration fails closed.
5. The actual Dispatch/Driver pickup address wins over a NetSuite or yard
   default when billing route evidence is assembled.
6. Staff may edit both billing origin and billing destination in MBT Billing.
   The pair is stored locally with optimistic revision checking and audit
   evidence. It changes candidate routing and recalculation only; it never
   writes Dispatch, Driver, reconciliation, or NetSuite source records.
7. Ordinary replenishment TOs appearing on the same immutable Driver load and
   the same consolidated physical pickup visit form one multi-drop billing
   unit. Display labels such as `Load 1` are never identity.
8. The base distance for that TO unit is the longest origin-to-distinct-drop
   distance, not the sum of the driven stop sequence. Every other distinct
   drop adds the configured replenishment-TO additional-drop price. Duplicate
   physical destinations count once.
9. Direct-pickup TOs remain independent fixed additional-drop charges and are
   never absorbed into an ordinary replenishment multi-drop unit.
10. Billing conversion re-resolves the server-owned candidate and the latest
    revision-checked billing endpoints; stale client arithmetic or addresses
    cannot be posted.

## Dispatch endpoint override clarification (2026-08-20)

11. A non-blank dispatcher-entered pickup override is the billing origin and a
    non-blank dispatcher-entered delivery override is the billing destination.
    Both endpoints must flow together for SO, TO, and PO candidates, including
    Driver-backed candidates whose immutable visit evidence still contains an
    older address. Blank overrides retain the existing Driver/NetSuite/yard
    fallback order. This precedence changes billing route selection only; the
    immutable Driver visit and Dispatch source rows remain unchanged.

## Acceptance examples

| Scenario | Expected result |
|---|---:|
| 30.001–50.000 km configured flat band | CAD 285.00 |
| 75.000 km | CAD 385.00 |
| 80.000 km | CAD 385.00 + 5 × CAD 7.00 = CAD 420.00 |
| TOB00888-S1 + TOB00907 + TOB00903, one shared pickup/load, three distinct drops | longest origin/drop band + 2 × configured TO additional-drop price |
| two drivers each showing `Load 1` | two independent billing units |

## Failure model and required behavior

| Failure | Required behavior |
|---|---|
| Fractional/negative/unsafe metres or money | Reject; never coerce |
| Base amount without included metres, or vice versa | Reject configuration |
| Included metres above the selected distance | Base amount only; no negative excess |
| Cent multiplication overflow | Reject |
| Missing origin or destination | Candidate remains non-chargeable unless staff supplies both billing endpoints |
| Concurrent endpoint saves from the same revision | Exactly one winner; the rest receive revision conflict |
| Candidate identity changed since override | Reject retained override |
| Same load label with different immutable load IDs | Never merge |
| Same immutable load with two separate pickup visits | Never merge across pickup visits |
| Route resolver fails for one candidate drop | Automatic calculation fails/manual-rate path remains explicit; do not silently select a shorter drop |
| Stale manual charge after endpoint recalculation | Reject conversion and require recalculation |

## Evidence commands

The persisted one-entry command for this change is
`npm run gauntlet:mbt:mbbs-cross-charge-v4`. It must run focused tests,
property/adversarial checks, integration/concurrency coverage, type checking,
lint, coverage thresholds, mutation checks, and a source-state guard.
