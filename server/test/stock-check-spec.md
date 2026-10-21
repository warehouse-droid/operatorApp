# SCM Stock Check — acceptance specification

Tier 3: vendor credentials, stock decisions, refreshes, and cart mutation.
Spec approval: not obtained (autonomous run); implementing the user's requested
module and keeping this specification reviewable. No git commits are requested.

## Requested behavior

1. SCM/admin see a Stock Check entry in SCM and its sidebar. It opens an editable
   vendor product catalog, with links to Test Stock Check and Vendor Setup.
2. Vendor Setup is inside Stock Check. Every vendor can have one or more named
   accounts. An account can be selected for that vendor's jobs. Passwords are
   encrypted with an application data key, never returned to the browser, never
   included in logs, screenshots, job payloads, or source control.
3. Unilock Ontario is the first implemented adapter. Other vendors can be added
   with accounts, but cannot execute until a method is implemented and tested.
4. Catalog scraping reads each selected colour/size's product label: description,
   finish, colour, shape/size, primary pickup plant, exact vendor SKU, source URL,
   and image URL. Endura Coping 24x14 Cham Oat Beige, SKU 177ECS0163703-0, must
   retain Pickering when the live selected-product label says Pickering.
   Shipping location and general paver/wall defaults cannot replace that label.
5. Repeated colour controls and variants are deduplicated by vendor + exact SKU.
   A missing or unfamiliar pickup label is reported as an extraction failure;
   it is not guessed from the SKU or item category.
6. SCM can search, edit, and manually add product records. A refresh updates the
   scraped fields while preserving explicit SCM overrides. Clearing an override
   restores the scraped value. Refresh failures never delete previous records.
   Concurrent stale edits receive a conflict instead of overwriting newer edits.
7. Refreshes run as tracked background jobs with progress, per-product failures,
   cancellation, bounded browser concurrency, and a final import summary.
8. The separate test page accepts vendor, item name/SKU, and pallet quantity. It
   searches the catalog and requires selection of an exact variant when more
   than one matches. Quantity is a positive whole number of bundles/pallets.
9. A live check logs in with the selected vendor account, uses pickup at the
   catalog's effective primary pickup point and the earliest allowed date, then
   matches exact SKU, colour, and size. Georgetown/Pickering can be attempted as
   declared Unilock fallback locations. Each attempt has its own result.
10. Stock is confirmed only after the native Add to Cart action is accepted and
    the full cart contains the exact SKU at the requested bundle quantity.
    An explicit vendor stock shortage is insufficient_stock. Authentication,
    extraction, selector, date, transport, ambiguity, and other portal failures
    are scrape_failure, with a reason for SCM review. A generic 'Available' label
    and an HTTP 200 response alone cannot confirm quantity availability.
11. Test results display status, exact product, pickup/date/quantity, timestamps,
    per-step success/failure, and actual browser screenshots. Evidence is served
    through authorized SCM endpoints. Browser cookies are not required to view
    the stored evidence from another computer. Cart sharing is not assumed.
12. Live tests preserve pre-existing cart lines/quantities and pickup settings;
    checkout/order submission is outside scope. Cleanup failures are reported
    and prevent claiming a fully successful check. Catalog scraping adds no
    cart items. Tests are serialized per vendor/account to avoid cart races.

## Failure model and verification

- Wrong colour/size/location: fixture portal tests plus the user's live Endura
  example; exact selected SKU and plant assertions; property tests for matching.
- False stock confirmation: tests for low-stock labels, rejected Add to Cart,
  partial quantities, wrong units, duplicate existing cart lines, and cart errors.
- Credential disclosure / unauthorized access: encryption/tamper tests, role
  tests for every route, redacted JSON/log tests, authorized evidence access,
  secret scan, and fixed-origin navigation tests (no arbitrary vendor URLs).
- Refresh erases SCM edits: real PostgreSQL tests for overrides, deduplication,
  partial imports, version conflicts, cancellation, and repeated refreshes.
- Concurrent cart mutation / stalled jobs: queue claim/concurrency tests,
  cancellation and interrupted-job recovery, registered finally cleanup.
- Unbounded workload: one active vendor browser job, navigation timeouts, a
  read-only catalog crawl with throttling, bounded screenshot size, and host
  resource policy checks.
- Broken UI: browser tests for catalog editing, vendor/account setup, exact
  product selection, status polling, and screenshot/result display.
- Existing application changes: capture the running application source before
  patching shared files, compare source hashes, run existing SCM/auth regressions,
  and use the repository's release/rollback pattern with production health checks.

## Setup and evidence

- Reuse Node 20, PostgreSQL, Express, existing test tooling and encryption
  primitives. Promote the already pinned Playwright 1.62.1 library to a runtime
  dependency; its Chromium browser is required for real screenshot evidence and
  the vendor's JavaScript controls. No AI dependency is needed.
- Add a stock-check migration, domain, credential vault, vendor adapters,
  repository, worker/runtime, router, catalog/test/setup pages, tests, and a
  persisted gauntlet/release entry point. Keep changes to existing menu/server
  wiring narrow and preserve unrelated workspace edits.
- Synthetic portal credentials only inside disposable test containers. Live
  vendor credentials are used solely in authorized operational processes.
- Register teardown before test environments start. Use the standard isolated
  Compose services, mbbs-tests.slice, memory/swap/PID/CPU/tmpfs limits. Remove
  test containers, volumes, and unused networks on every exit, and verify both
  docker ps and docker ps -a plus production health. Keep evidence, not databases.
- Record RED behavior failures before implementation; then final tests, lint,
  types, coverage, property tests, mutation, browser execution, source hashes,
  dependency/secret checks, and all skipped layers with reasons. Live catalog
  and live vendor checks are operational evidence, separate from fixture tests.

## Clarification A — pre-existing cart quantities

The stock test submits the requested quantity through Add to Cart. If the same
SKU already has Q bundles, the expected cart total is Q + requested quantity;
the evidence records both quantities and confirms the full requested increment.
Cleanup restores Q. If a shortage is rejected while Q is nonzero, the result is
scrape_failure with an existing-cart explanation, because a rejection against a
cumulative cart quantity cannot establish the requested quantity's availability.
Other pre-existing lines must remain unchanged. This clarification keeps the
test's meaning precise without deleting an operational cart line before checking.

## Clarification B — displayed plants outside Ontario pickup choices

Live discovery found Arcana variants whose selected label says Chicago and
natural-stone variants with an empty selected pickup label. The catalog must
retain these exact-SKU records and their observed labels, with pickupCode=null
and pickupNeedsReview=true, so SCM can correct them. The stock tester must not
invent an Ontario pickup code for them. Strict normalization remains the default;
the catalog importer explicitly opts into retaining unmapped source labels.
### Clarification C — vendor SKUs containing spaces

The live catalog has SKU `RM-PCKG 03 SPC01`. Retain internal spaces in exact vendor identifiers; reject markup and URL control characters. This is a catalog record with the same pickup-review rules as other variants.
### Clarification D — a fresh Unilock session may have no selected request date

The authenticated live portal displays Pickup/Ayr with an empty request-date input and no date in the shipping label. If the original cart is empty, choose the earliest enabled native date, restore only previously configured settings, and close the isolated session. If a nonempty cart has no readable original date, stop for SCM review before modifying it. Bind the portal's `beforeShowDay` callback to its date input, as the native widget does.
### Clarification E — the live cart's Order Summary is the saved-date authority

Unilock may leave both the welcome date input and shipping header without a date while the existing cart's Order Summary says `Requested By: 10/15/2026`. Read that saved date before any mutation and verify dates from Order Summary. Restoration uses the portal's own date selection/close callbacks for the exact recorded original date; no new stock check may select a disabled date. Keep the five-bundle existing line intact and restore its quantity after confirming the requested increment.
### Clarification F — Add to Cart completes in a modal

The live native Add action displays `Your item has been added` without page navigation. Recognize native navigation, this visible confirmation, or a vendor dialog as action completion; then read the full cart and require the exact SKU, bundle increment, pickup and saved date. A modal or mini-cart count alone never confirms stock. The live attempt accepted five additional bundles (ten total including the original five) and successfully restored the original five and October 15 date.

### Clarification G — SCM pickup corrections apply to live checks

After SCM replaces an unfamiliar source plant with a supported Ontario pickup point, a stock test uses that effective pickup. Reading the selected product must retain the original source plant without rejecting it or inventing a code; the step evidence displays that plant. The cart must still independently confirm the SCM-selected pickup, exact SKU, requested increment and request date.

### Clarification H — Stock Check pages scroll as documents

The catalog, test page, and vendor setup must allow wheel/touch scrolling to the
last row or result at desktop and mobile widths. They must not inherit the
dispatch dashboard's fixed-height grid or hidden body overflow. Catalog tables
may scroll horizontally, and dialogs retain their own scrolling. Override layout
only within Stock Check and refresh the stylesheet URL so existing browsers load
the correction.

### Clarification I — vendor availability is separate from cart acceptance

The user demonstrated that Unilock accepts scheduled-production items into the
cart. For exact SKU `02U1183661507-0`, Urban 6 cm 18x36 Indiana Buff, two bundles
show `Production Scheduled for - 2026-10-20`; Beacon Hill SKU `0262XL0631907-0`
shows `Available`. Confirm immediate stock only when the native requested cart
increment is verified and that same cart row's Availability column explicitly
reports Available/In Stock. Preserve the vendor text and production ETA in the
saved result and screenshots. A known production schedule is `in_production`,
not immediate stock and not a scraping failure. Missing, conflicting or unknown
availability is a scrape failure requiring SCM review; it must never default to
stock confirmed. A production schedule on the selected BNDL option can be
reported before Add without adding an unnecessary future-stock cart line.

Historical positive results that recorded only cart acceptance must display as
availability_unverified. Preserve their underlying audit records and accepted
quantity; do not retroactively claim they were in stock or out of stock. Record
cart acceptance and availability as distinct steps. With an existing same-SKU
line, production availability applies to the cumulative tested cart quantity;
the requested increment's immediate stock is not established.

### Clarification J — stop before Add to Cart and capture availability lower down

The user requests removal of every current Unilock cart line as a one-time
operational action. All subsequent stock checks must stop before Add to Cart,
including available, low-stock, production, unavailable and unfamiliar results.
Never enter a quantity, add a line, update a quantity or remove a line during a
stock check. Read the exact selected variant's BNDL availability, with its
visible product label as a fallback. Retain the vendor text and any production
ETA. Available results are vendor-reported availability; the requested quantity
is a reference, with no accepted or verified quantity. This supersedes earlier
requirements to submit quantities or confirm cart acceptance. Existing results
and audit records retain their historical meaning.

Scroll the availability control into the screenshot viewport before capturing
product selection and availability evidence. Keep pickup/date selection and
restoration, cancellation, protected evidence and unknown-status review. Tests
must assert zero cart writes across all verdicts and verify that controls below
the initial viewport actually appear in saved screenshots.

### Clarification K — Recent Checks has its own tab and master/detail view

Move the recent check list from Test Stock Check to a dedicated Recent Checks
tab. Show the selected vendor's recent checks as a selectable master list and
the selected result, exact variant, availability, dates, steps and protected
screenshots as its detail. New stock checks open that tab with their queued
result selected. Selection remains highlighted and survives refresh/reload;
search filters the master list. Empty vendors clear the previous result.

Use adjacent panels on desktop and stacked panels on phones. Handle both the
collapsed and expanded sidebar. Earlier detail or evidence responses must not
replace a later selection or another vendor's result. Preserve existing stock
checks, private evidence and the no-Add-to-Cart behavior.
