# Vendor Replies editable unit price — executable specification

Tier 3: unit prices become purchase-order money, and a wrong scope or stale
snapshot can create an incorrect PO.

```gherkin
Feature: Edit a Vendor Replies unit price without changing Item Master

  Scenario: Vendor-specific price wins over Last Purchase Price
    Given BWS-DC-CHAR has NetSuite Item Vendor price CAD 12.60
    And its Item Master Last Purchase Price is CAD 10.67
    When Vendor Replies loads the item for BWS
    Then Unit price is CAD 12.60
    And Amount uses CAD 12.60 per purchase unit

  Scenario Outline: Missing vendor price falls back to Last Purchase Price
    Given an item's NetSuite Item Vendor price is <vendor price>
    And its positive Item Master Last Purchase Price is CAD 10.67
    When Vendor Replies loads the item
    Then Unit price is CAD 10.67

    Examples:
      | vendor price |
      | empty        |
      | zero         |
      | invalid      |

  Scenario: Material price is edited and saved for one load
    Given an editable Vendor Replies load whose item-master price is CAD 1.64
    When the user saves CAD 2.75 for one material line
    Then that load reloads with CAD 2.75
    And its decision amount is recalculated from decision sales quantity
    And another load for the same item still uses CAD 1.64
    And inventory_items.last_purchase_price remains CAD 1.64

  Scenario: PALLET price is edited for the load
    Given an editable load with one or more official PALLET destination rows
    When the user saves CAD 5.50 from a PALLET row
    Then every PALLET destination row in that load uses CAD 5.50
    And inventory_items.last_purchase_price for PALLET remains unchanged

  Scenario: Clearing an override restores the source price
    Given a saved material or PALLET price override
    When the user clears the price and saves
    Then the override is removed
    And the Vendor Replies load uses the current positive vendor price again
    Or it uses Last Purchase Price when vendor price is empty or zero

  Scenario: Confirmed prices are snapshotted into PO review
    Given an editable regular PO load with saved material and PALLET prices
    When the user confirms the load
    Then the staged NetSuite PO review uses those saved prices
    And later Item Master changes cannot alter the review snapshot

  Scenario: A linked real NetSuite PO becomes the current displayed price
    Given a Vendor Replies workflow has created a real NetSuite Purchase Order
    And the confirmed Vendor Reply prices remain stored as audit evidence
    When OAuth history or the NetSuite webhook provides a current PO line rate and amount
    Then Vendor Replies displays that canonical PO rate and amount
    And the line is matched by exact NetSuite item and destination yard identity
    And the original Vendor Reply confirmation price is retained separately

  Scenario: A later NetSuite PO price edit reaches Vendor Replies
    Given the real NetSuite Purchase Order is linked to a Vendor Replies workflow
    When NetSuite changes the PO line rate or amount after creation
    Then both supported webhook senders include rate and amount
    And the application receiver persists rate and amount on the canonical PO line
    And an open Vendor Replies tab refreshes only the Vendor Replies queue
    And the new NetSuite PO rate and amount are displayed

  Scenario: Invalid prices are rejected atomically
    Given an editable Vendor Replies load
    When a user submits zero, a negative number, a non-number, or an excessive price
    Then the request fails with status 400
    And no decision, material price, PALLET price, or Item Master price changes

  Scenario: Locked workflows cannot edit prices
    Given a workflow that is no longer editable
    Then Unit price is rendered as read-only money
    And no editable unit-price input is present
```

Constraints:

- Prices are CAD per displayed purchase/sales unit, positive, finite, at most
  999,999,999, and normalized to six decimal places.
- Default price precedence is saved load/review snapshot, positive NetSuite Item
  Vendor purchase price, then positive Item Master Last Purchase Price.
- Blank means reset to the current vendor-price/LPP source; blank is not saved as
  zero.
- Material overrides are proposal-line scoped. PALLET has one proposal-level
  override because it is one official item even when shown for multiple yards.
- Existing unit-mismatch blocking remains unchanged.
- Before a real PO exists, saved/vendor/LPP precedence remains unchanged. After
  a real PO is linked, its exact item-yard canonical line is the current display
  source while the confirmation snapshot remains immutable audit evidence.
- No new dependency, network, filesystem, or subprocess capability is added.
