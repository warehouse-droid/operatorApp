# Special-item stock request — executable specification

Tier 3: this workflow creates or links live NetSuite Sales Orders and Purchase
Orders, stores customer contact and delivery media, and changes Dispatch pickup
behavior. The approved implementation plan is the authorization for this spec.

No new runtime dependency is authorized. Existing PostgreSQL, NetSuite REST,
R2/photo upload, Server-Sent Events, and Dispatch dependency services must be
reused. All migrations are additive and the feature is disabled by default.

```gherkin
Feature: Sales and Purchase control a multi-line special-item case

  Scenario: Sales submits one multi-line case for one vendor
    Given a private Sales user has access to inquiry store 3445
    When Sales submits two positive product quantities with customer and vendor details
    Then one SPREQ case with two independently revisioned lines is created
    And no inventory reservation, Sales Order, Purchase Order, or Dispatch link is created

  Scenario: Public and cross-yard Sales access fail closed
    Given a public Sales session or a Sales user without access to the case store
    When the session lists, opens, or mutates a special case
    Then no customer, phone, note, cost, media, or order information is exposed

  Scenario: SCM responds to each line without exposing purchase cost
    Given a submitted two-line case
    When SCM records In Stock for one line and Production with a ready date for the other
    Then Sales sees both supply responses and Sales-visible notes
    But Sales and Dispatch projections contain no unit purchase cost or SCM-only note

  Scenario: Vendor Transfer is informational only
    Given SCM selects Vendor Transfer
    When the response is saved
    Then no MBBS Transfer Order, reservation, dependency, or Dispatch plan record is created

  Scenario: A changed response invalidates customer acceptance
    Given Sales accepted the current response for one line
    When SCM records a newer ETA or supply revision
    Then the prior acceptance remains in immutable history
    And the line returns to Awaiting Sales with a required new acknowledgement

  Scenario: Sales resolves lines independently but releases the case together
    Given a case has accepted, declined, and still-pending lines
    Then Create Sales Order is unavailable
    When every line is accepted, declined, or closed
    Then only accepted lines are eligible for the Sales Order

  Scenario: One case cannot span canonical vendors
    Given accepted lines resolve to different NetSuite vendors
    When Sales attempts Sales Order preparation
    Then release is blocked and no remote order is created
    And Sales is instructed to separate the vendor lines into another case

  Scenario: Sales transforms an optional Estimate into one Sales Order
    Given an active NetSuite Estimate covers every accepted line for the selected customer
    And the delivery payload contains a free-text address, Toronto date and time window,
        nonblank instruction text, and staged instruction media
    When Sales confirms the reviewed order once or repeatedly
    Then exactly one Sales Order is transformed from the Estimate
    And the case marker, delivery date, window, and instruction text are written to NetSuite
    And the same text and media become the revisioned Dispatch and Driver instruction

  Scenario: Sales creates a standalone full Sales Order
    Given no Estimate is linked and every accepted material has an exact NetSuite item mapping
    When Sales reviews material rates, operational yard, and optional ancillary lines
    Then exactly one standalone Sales Order is created and hydrated into the canonical mirror
    And the same case cannot create or link another Sales Order

  Scenario: Sales links an existing Sales Order manually
    Given Sales enters an existing Sales Order number
    When the live active order matches the customer and covers all accepted line quantities
    Then its exact lines are linked to the case
    But an order owned by another case, a closed order, or mismatched coverage changes nothing

  Scenario: Purchase waits for approved active Sales Order
    Given the linked Sales Order is Pending Approval, Closed, Cancelled, or missing
    Then SCM cannot create or link a Purchase Order
    When NetSuite reports the Sales Order active and fulfillment-ready
    Then the Purchase Order review becomes available

  Scenario: SCM creates one exclusive Purchase Order
    Given one approved Sales Order and one canonical vendor cover all accepted lines
    When SCM confirms exact PO line quantities, purchase UOMs, costs, and the same operational yard
    Then exactly one recoverable application PO is created for that case and SO
    And it is registered in application-created PO history
    And no active Dispatch SO-to-PO allocation exists yet

  Scenario: SCM links an existing unshared Purchase Order manually
    Given SCM enters an active Purchase Order number
    When its vendor, yard, UOM, descriptions, and quantities cover the exact accepted SO lines
    Then it becomes the exclusive PO for the case
    But any PO linked or allocated to another SO or case is rejected atomically

  Scenario: Dispatch handoff is automatic but routing remains controlled
    Given exact SO and PO line links are complete for an MBT delivery
    Then one indexed handoff appears automatically under Needs Route
    And the global Dispatch order pool is unchanged
    When Dispatch selects Direct
    Then exact existing SO-to-PO allocations activate the vendor pickup manifest
    When Dispatch instead selects Via Yard before execution
    Then the PO is inbound to the selected SO operational yard and the SO waits for receipt

  Scenario: Customer pickup routing follows the selected fulfillment method
    Given Customer Pickup at MBBS Yard is selected
    Then the handoff is Via Yard and cannot become Direct
    Given Customer Pickup at Vendor is selected
    Then no Dispatch handoff is created and Sales records pickup date and reference

  Scenario: Route mutation is fenced after execution begins
    Given a handoff is planned, picked up, received, present on a driver device, or completed
    When Dispatch tries to change or remove its route
    Then the existing dependency blocker rejects the mutation without partial unlinking

  Scenario: A post-PO vendor delay requires acknowledgement
    Given an exclusive PO exists
    When SCM publishes a newer ETA or supply status
    Then NetSuite orders and Dispatch planning are not silently changed
    And Sales and Dispatch show Attention until Sales records a new customer acknowledgement

  Scenario: Closure never abandons a live order
    Given no SO or PO exists
    Then Sales may close with a required reason
    Given an SO exists but no PO
    Then Sales closure becomes Closure Pending until NetSuite closes or cancels the SO
    Given a PO exists
    Then Sales cannot close and SCM or Admin must first resolve both remote orders

  Scenario: Operational completion and NetSuite reconciliation remain separate
    Given Driver, Operator, or Sales records the required physical completion
    Then the case shows Operationally Complete
    And any non-terminal NetSuite SO or PO remains a visible reconciliation status
    But remote reconciliation never erases immutable physical completion evidence

  Scenario: Existing Regular and Driver PWA behavior is unchanged
    When the special feature flag is disabled
    Then Special is unavailable for mutation and Regular behaves exactly as before
    And Driver PWA receives only its existing normal jobs and instruction projection
```

## Approved sequencing revision — 2026-08-21

The order of responsibility is part of the authorization boundary. The first
SCM reply is an availability reply, not an order-line mapping step.

```gherkin
Feature: Sales and SCM hand off a special-item case in two controlled replies

  Scenario: The initial Sales form captures an actionable multi-line inquiry
    Given Sales starts a new Special Item case
    Then Case inquiry date is shown instead of a case-level required date
    And the optional estimate field is labelled NetSuite Quote ID (optional)
    And Customer and Vendor accept a synced autocomplete choice or free text
    And selecting a canonical customer fills its phone while leaving the phone editable
    And each line accepts only Plt, lyr, Sec, Pcs, or Each
    And each line required date defaults to and cannot precede three Toronto working days from today
    And the desktop initial form displays no more than three inputs per row

  Scenario: SCM's first reply does not require an exact item mapping
    Given Sales submitted a case line
    When SCM records vendor, yard, supply status, projection, and the Sales-visible reply
    Then the response is saved without a NetSuite item ID, sales UOM, or order quantity
    And no SO draft, PO draft, or PO-ready marker is created

  Scenario: Sales follows up with the customer and resolves the Sales Order line
    Given SCM's first reply exists
    When Sales accepts the line
    Then Sales must select an exact synced NetSuite item, description, sales UOM, and sales quantity
    And the accepted mapping is revisioned with the customer follow-up
    But a declined or closed line needs no item mapping
    And Sales may create or link the SO only after every line has a terminal decision

  Scenario: SCM's second reply prepares an accepted line for Purchase Order creation
    Given an exact active SO is linked to the case
    When SCM records the second reply for an accepted line
    Then its item ID, description, sales UOM, and sales quantity cannot differ from the linked Sales mapping
    And SCM may set the purchase UOM, purchase quantity, pallet quantity, unit cost, and vendor details
    And the accepted line receives a durable PO-ready marker with actor and timestamp

  Scenario: Every accepted line requires a second SCM reply before a PO action
    Given an approved active SO is linked
    And at least one accepted line is not PO-ready
    When SCM creates or links a PO
    Then the server rejects the action before any remote or local PO mutation
    When SCM completes the second reply for every accepted line
    Then PO create or link may continue through the existing exact-coverage checks

  Scenario: A changed first reply invalidates unfinished Sales work
    Given no remote SO exists and Sales accepted or drafted an earlier SCM reply
    When SCM saves a revised first reply
    Then the prior Sales decision and item mapping are cleared
    And any local SO and PO draft lines are cleared atomically
    And Sales must acknowledge the new response before SO release

  Scenario: Concurrent handoffs cannot bypass the sequence
    Given Sales, SCM, or a PO operation uses the same expected case revision concurrently
    When two mutations race
    Then the row lock and compare-and-swap revision allow at most one winner
    And a PO claim racing the second response cannot succeed while any accepted line is not PO-ready

  Scenario: Existing operations remain isolated
    Given the Special Item feature flag is off
    Then no new Special mutation is available
    And Regular stock requests, Dispatch planning, and Driver PWA contracts are unchanged
```

## Failure model and defenses

| Failure mode | Required defense and test layer |
|---|---|
| Duplicate SO/PO after double click or timeout | Stable idempotency key, durable marker search, unit plus ambiguous-network integration tests |
| Remote success followed by local failure | Persist execution Attention state and retry only hydration/instruction/history steps |
| Close racing order creation | Case advisory/row lock, expected revision, concurrency test proving one winner |
| SCM revision racing Sales acceptance | Request and line revisions with compare-and-swap concurrency coverage |
| PO starts before SCM's second reply | Durable per-line PO-ready evidence plus server-side create/link/claim fences |
| SCM changes the linked SO mapping | Immutable item/sales fields after SO link and exact canonical coverage checks |
| Shared or over-allocated PO | Unique order ownership plus exact line allocation transaction and adversarial DB tests |
| Cost or PII leakage | Role-specific SQL projections, auth tests, and browser payload assertions |
| Mixed vendor or UOM mismatch | Pure normalization policy, property tests, exact live preflight |
| Stale webhook regresses state | Remote timestamp/status precedence and immutable event history tests |
| Media orphaned around remote creation | Case staging identity, promotion retry, and interrupted-finalization tests |
| Direct link affects planned/split/group work incorrectly | Existing dependency blockers plus group/split/snapshot integration matrix |
| Unbounded list/search/history | Indexed case stages, normalized limits/search, bounded event/media lists |
| Hidden production failure | Attention states, audit events, SSE notifications, and observability assertions |

## Compatibility and rollout constraints

- No spreadsheet import or legacy case-number backfill.
- One case contains many lines but exactly one canonical vendor and one SO.
- SCM's first reply may omit item resolution; Sales resolves accepted lines before SO release.
- Every accepted line has a durable second-SCM-response marker before PO create or link.
- Special workflow POs are exclusive to their SO and cannot be shared.
- Delivery requires free-text address, date, start/end window, instruction text,
  and allows optional staged image/video media.
- Existing Regular stock requests, Smart SCM, Dispatch grouping/splitting,
  dependency management, snapshots, receiving, and Driver offline schemas keep
  their public contracts.
- The feature flag defaults off; no production NetSuite write is part of the
  automated gauntlet. Live contract execution is sandbox-only and separately
  authorized.
