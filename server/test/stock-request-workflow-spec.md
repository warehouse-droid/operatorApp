# Sales regular stock request — executable specification

Tier 3: this workflow controls shared inventory, creates and revises NetSuite
Transfer Orders, exposes yard-scoped Sales data, and bridges local, dispatch,
driver, print, and receiving state.

Spec approval: obtained from the user through the approved implementation plan
and the instruction to implement and deploy after all tests pass.

August 12 backorder amendment: the user directly instructed that SCM must be
able to enter and convert the full requested quantity when current availability
is lower (the concrete acceptance case is 10 requested and 1 available). A
separate pre-implementation review of the amended executable spec was not
obtained; the user's instruction is the acceptance criterion. The conversion,
concurrency, and pending-TO scenarios below supersede the former availability
cap for SCM only. The Sales submission gate remains unchanged.

```gherkin
Feature: Sales requests regular stock from another authorized yard

  Scenario: Private Sales creates a multi-line request
    Given a staff Sales user has access to destination yard 1
    And two selected inventory items have live availability at source yards 28 and 15
    When the user submits both lines to destination yard 1
    Then one request with a stable STREQ reference and two independently sourced lines is created
    And no inventory reservation or NetSuite transaction is created

  Scenario: A single-yard Sales user has a fixed destination
    Given a staff Sales user has access to exactly destination yard 1
    When the Request Stock page loads
    Then yard 1 is fixed and no other destination can be submitted

  Scenario: A multi-yard Sales user chooses an authorized destination
    Given a staff Sales user has access to destination yards 1 and 28
    When the user selects yard 28
    Then yard 28 is accepted
    But destination yard 15 is rejected without changing state

  Scenario: Public Sales is denied
    Given an unauthenticated or public Sales session
    When it requests the page or any stock-request API
    Then it receives the private-login response
    And no yard inventory or request data is exposed

  Scenario: Yard-scoped Sales visibility is enforced
    Given requests exist for destination yards 1 and 28
    And a Sales user has access only to yard 1
    When the user lists or opens requests
    Then only yard 1 requests are returned
    And directly opening a yard 28 request is forbidden

  Scenario: Selecting an item refreshes all supported yards through NetSuite OAuth 2.0
    Given a locally searchable inventory item
    When Sales selects the item
    Then the backend refreshes availability for yards 1, 28, 15, and 26
    And returns the persisted refreshed balances and refresh timestamp
    And the browser never calls NetSuite directly

  Scenario: Search and list endpoints are bounded
    Given a broad or hostile search term and many records
    When Sales or SCM requests a list
    Then normalized limits and escaped search parameters bound the response

  Scenario: Quantity fields follow item conversion metadata
    Given an item has positive PLT, SEC, LYR, and PCS conversions
    Then those conversion quantity fields are accepted and normalized to sales quantity
    But mixed conversion and sales-quantity input is rejected
    Given an item has no usable conversion
    Then sales quantity and sales UOM are required

  Scenario: Invalid quantities are rejected atomically
    Given a draft request
    When a line contains zero, a negative value, a non-finite value, an excessive value, a fractional LYR, or source equals destination
    Then the request fails with status 400
    And no request, line, reservation, or NetSuite transaction changes

  Scenario: Sales edits or cancels before an SCM decision
    Given a submitted request has no SCM decision
    When an authorized Sales user edits its lines or cancels it with the current revision
    Then the change succeeds and increments the revision
    But a stale revision or any edit after the first SCM decision is rejected

  Scenario: SCM requests changes for selected lines
    Given a submitted multi-line request
    When SCM returns selected lines with a required reason
    Then only those lines become editable by Sales
    And Sales can resubmit them with a current revision
    And the other lines keep their existing decision state

  Scenario: SCM rejects selected lines with a reason
    Given a submitted request
    When SCM rejects selected lines with a non-blank reason
    Then those lines are terminal and the reason is visible to Sales
    But a blank reason or stale revision changes nothing

  Scenario: SCM conversion refreshes availability and creates reservations atomically
    Given submitted lines have no reservation
    When SCM converts selected lines
    Then availability is refreshed and existing active reservations are deducted
    And one local pending TO is created per source/destination pair
    And each converted line is reserved exactly once
    And any quantity above refreshed requestable availability is retained as an explicit backorder
    And the requested quantity, requestable quantity, and backorder quantity are audited
    And NetSuite is not called

  Scenario: Concurrent conversion serializes availability snapshots without dropping demand
    Given two requests compete for the same final available units
    When SCM converts them concurrently
    Then advisory and row locks serialize their refreshed availability snapshots
    And both requested quantities are reserved for their pending TOs
    And the shortage on the later conversion is retained and audited as backorder

  Scenario: SCM enters the full requested quantity despite current shortage
    Given Sales requested 10 units and refreshed requestable availability is 1
    When SCM saves 10 units on the request or pending TO
    Then the quantity remains 10
    And the UI shows current availability 1 and backorder 9
    And confirmation may create the NetSuite Transfer Order for all 10 units

  Scenario: Local accepted reservations reduce future requestable availability
    Given a pending local stock transfer reserves ten units at yard 28
    When availability is shown for the same item and yard
    Then requestable availability equals live on-hand availability minus ten
    And submitted but unconverted requests do not reduce it

  Scenario: PALLET lines follow the official packaging rule
    Given converted material quantities with full pallets and loose remainders
    When SCM creates a local pending TO
    Then the official PALLET item quantity is one per full PLT plus one per SKU with a loose remainder
    And SCM may explicitly adjust it
    But an item without PLT conversion requires a non-negative manual PALLET quantity before confirmation

  Scenario: Confirm and print creates one real TO despite retries
    Given an editable local pending TO with a stable external request marker
    When SCM confirms and prints it more than once because of a timeout or retry
    Then marker recovery returns one NetSuite Transfer Order
    And the canonical transfer mirror is linked once
    And one current dual-printer ticket revision is queued

  Scenario: A remote success followed by approval or print failure is recoverable
    Given NetSuite created a TO but a later approval, hydration, or print step failed
    When SCM retries confirm and print
    Then the existing TO is recovered by marker
    And only the incomplete steps are retried
    And the failure remains visible instead of being reported as full success

  Scenario: Pending TO quantity revisions are safe and auditable
    Given a local or real pending TO has no outbound fulfillment
    When SCM changes quantity with the current revision
    Then the local reservation and, when present, NetSuite TO are synchronized
    And the prior print ticket is invalidated
    And an explicit re-print is required
    But partially fulfilled, pending-receipt, received, closed, or cancelled TOs cannot be revised

  Scenario: Webhooks reconcile linked stock transfers without regressing state
    Given a real TO is linked to a stock request
    When a newer NetSuite webhook reports fulfillment, receipt, cancellation, or quantities
    Then canonical transfer and stock-request state are updated and an SSE event is emitted
    But an older webhook or local revision cannot overwrite newer authoritative state

  Scenario: Sales Accepted view shows operational progress
    Given any line has a local or real TO and not all lines are terminal
    Then the request appears under Accepted
    And Sales can see local reference, NetSuite TO number, print state, dispatch assignment, and driver milestones

  Scenario: Driver completion does not complete a request early
    Given the driver completed delivery but NetSuite has not received the TO
    Then the driver milestone is visible under Accepted
    And the request moves to Completed only after every line is received, rejected, or cancelled

  Scenario: Disabled Special tab does not expose an incomplete workflow
    When Sales or SCM opens Stock Requests
    Then Regular is usable
    And Special is visibly marked Coming soon and cannot submit or mutate data
```

## Failure model and required defenses

| Failure | Required defense |
|---|---|
| Public access or cross-yard data leakage | Private staff middleware plus destination-yard filtering on every Sales query/mutation |
| Stale inventory or two SCM users converting concurrently | OAuth refresh before conversion, database transaction, advisory/row locks, active-reservation deduction, and an audited backorder snapshot |
| Partial local writes | Transactional request, line, transfer, reservation, and audit updates |
| Duplicate NetSuite TO after retry | Stable per-transfer marker, persisted attempt state, remote marker recovery before create |
| NetSuite create succeeds but later step fails | Persist remote ID as soon as recovered/created; independently retry approval, hydration, and print |
| Unsafe quantity edit after fulfillment | Existing authoritative fulfillment/receipt status blocker plus fresh remote verification |
| Stale browser overwrites newer decision | Required integer revision on every mutation; optimistic compare-and-swap |
| Older webhook regresses state | Monotonic external timestamps/status precedence and canonical mirror as authority |
| Unit conversion overflow or ambiguity | Finite bounded decimal parsing, no mixed input modes, exact server normalization |
| Wrong grouping | Unique source/destination grouping and one reservation per request line |
| Wrong PALLET quantity | Pure tested packaging calculation and explicit SCM override |
| Driver completion treated as receipt | Separate milestone projection; terminal completion only from receipt/reject/cancel |
| Stale print ticket reused after edit | Transfer revision on job metadata, invalidate on quantity edit, explicit re-print |
| Search or list performance degradation | Minimum query length where appropriate, normalized limits, indexed predicates, no full live sync |

## Compatibility constraints

- Existing Sales, Dispatch, Driver PWA, SCM proposal, PO/TO schedule, printing,
  and canonical NetSuite webhook behaviors must remain unchanged outside this
  additive module.
- The browser must use same-origin application APIs; only the backend may use
  NetSuite OAuth 2.0.
- No new runtime dependency is required.
- Supported yards remain NetSuite/local pairs `3445/1`, `2967/28`, `12441/15`,
  and `150/26`.
- Existing SCM-only explicit reservation overrides retain their current
  semantics; this module only adds its active reservations to shared available
  inventory calculations.

## August 11 workflow and list enhancements

Spec approval for this append-only enhancement: not separately obtained; this
is an autonomous continuation of the user's requested workflow changes.

```gherkin
Feature: Stock-request attention, filtering, and terminal TO handling

  Scenario: Feedback never consumes the working viewport
    Given either Stock Request page displays a notice or error
    Then the feedback row is content-sized
    And the request list and detail workspace retains the remaining height

  Scenario: Availability shows every useful quantity representation
    Given an item has positive PLT, LYR, SEC, and PCS conversions
    When Sales or SCM views a yard availability card
    Then the card shows requestable Sales quantity and Sales UOM
    And it also shows the equivalent PLT, LYR, SEC, and PCS quantities
    But conversion labels with no positive conversion are omitted

  Scenario: Returned requests demand Sales attention
    Given SCM requests changes on one or more submitted lines
    When Sales opens the Pending tab
    Then that STREQ sorts before ordinary pending requests
    And its pill reads Request Change
    And its list card has a light-yellow attention background

  Scenario: SCM changes a Request Changes decision before Sales resubmits
    Given a line is in changes_requested and Sales has not saved a newer revision
    When SCM converts or rejects that line using the current revision
    Then the action succeeds and returns visible feedback
    But a stale SCM or Sales screen cannot overwrite the winning decision

  Scenario: SCM rejects a local Pending TO before confirmation
    Given SCM converted a request into a local pending TO
    And Confirm TO + Print has not created or linked a NetSuite TO
    When SCM rejects the pending TO with a reason and current revision
    Then its active reservations are released atomically
    And its linked request lines become rejected with that reason
    And the request appears in SCM Rejected and the appropriate Sales bucket
    But a stale revision changes nothing

  Scenario: SCM cannot locally reject a confirmed NetSuite TO
    Given a pending transfer has a NetSuite TO ID or current print job
    Then the Reject Pending TO control remains visible but disabled
    And the repository rejects direct attempts without releasing reservations

  Scenario: NetSuite Closed remains a distinct terminal state
    Given a linked NetSuite TO receives a newer Closed webhook
    When the stock-request projection reconciles it
    Then the transfer and its linked request lines become closed
    And remaining reservations are released
    And SCM shows the record in a Closed tab
    And Sales shows the closed status under Completed
    But an older webhook cannot reopen the closed transfer

  Scenario: Sales filters apply to every status tab
    Given requests differ by item vendor, Toronto request date, and source yard
    When Sales selects any combination of those filters
    Then Pending, Accepted, and Completed use the same filter values
    And only matching yard-authorized requests are returned

  Scenario: SCM filters apply to every queue tab
    Given requests differ by item vendor, Toronto request date, source yard, and destination yard
    When SCM selects any combination of those filters
    Then Request, Pending TO, Rejected, and Closed use the same filter values
    And only matching requests are returned

  Scenario: Search remains usable during live refreshes
    Given Sales or SCM is typing in the search box
    When a debounced list refresh re-renders the page
    Then the search box retains focus and its caret
    And an older network response cannot replace results for a newer search

  Scenario: Sales adds a request-level remark
    Given Sales is composing a regular stock request
    When Sales submits an optional bounded remark with the request
    Then the remark is stored on the STREQ and visible to both Sales and SCM
    But oversized or control-character input is normalized or rejected without a partial request

  Scenario: Availability units use separate visual rows
    Given a yard has requestable inventory with conversion metadata
    Then Sales quantity and Sales UOM such as SQ FT appear on the first row
    And PLT, LYR, SEC, and PCS equivalents appear on a separate second row

  Scenario: Accepted history remains visible after completion
    Given SCM converted a request into a local or real Transfer Order
    When the request later becomes Received, Closed, or otherwise terminal
    Then Sales still sees it in Accepted as permanent TO history
    And it also appears in Completed with its terminal status
    But a request rejected before any TO existed does not appear in Accepted
```

Additional failure defenses:

- Pending-TO rejection locks the request and transfer, checks both revisions and
  remote identity, and releases reservations in the same transaction.
- Closed is never folded into Received or Rejected; it has its own database and
  presentation state.
- Filter values are normalized and bounded server-side; request dates use the
  `America/Toronto` company date.
- Vendor filtering uses the current NetSuite-owned item vendor projection and
  never weakens Sales destination-yard authorization.
- List refreshes use a monotonically increasing browser request generation so a
  late response cannot overwrite the current filter/search result.

## Accepted-history clarification — 2026-08-11

```gherkin
Scenario: A locally rejected Pending TO is Completed only
  Given SCM converted a request into a pristine local Pending TO
  And no NetSuite TO was created or linked
  When SCM rejects that Pending TO before Confirm TO + Print
  Then Sales shows the request in Completed
  And Sales does not show the request in Accepted
  But a cancelled transfer with a linked NetSuite TO remains permanent Accepted history

Scenario: Sales Request Stock is complete in Simplified Chinese
  Given Sales selects Simplified Chinese from the shared language control
  When the list, detail, filters, composer, validation, or progress state is shown
  Then every Sales Stock Request label, action, status, notice, and client validation is Chinese
  And server validation messages supported by this workflow are localized before display
  And changing the language rerenders the current screen without losing its state
```
