# SOR rentals acceptance specification

Approved by the user: “Implement the plan”, following the SOR rentals, automatic
returns, Admin item overrides, and optional Driver customer signatures plan.

## Executable scenarios

1. Named rental hierarchies and /Day or /Month items qualify; inventory types,
   unmatched non-inventory machines, and fees do not qualify by default. Stock
   balances never determine classification. Admin equipment overrides win.
2. Admin-only item search shows defaults, overrides and impact. A stale revision
   cannot overwrite another edit; source sync preserves overrides and audit.
3. Rental Delivery pickup is 3445 Kennedy Road (physical location 1), while source
   Rental location 50 is retained. Notes/overrides determine the customer address.
   Service equipment with positive quantity is physical cargo, even at zero pallets.
4. Each eligible delivery leaf creates exactly one undated local SOR...-Return,
   with only eligible rental quantities, customer-site pickup and 3445 dropoff.
   Customer Pick-Up and sales-only orders do not generate returns.
5. Splits keep -S1/-S2 in the return reference, never regain full parent quantities;
   grouping changes neither identity nor quantities and creates no wrapper return.
6. Repeated/concurrent sync and process restart cannot duplicate returns. Source
   and Admin changes update unassigned returns, cancel empty ones, and flag assigned
   or started work. Completed history and outstanding returns after billing survive.
7. Missing addresses block assignment. Collection requires completed delivery but
   can be planned in advance. Backfill only currently eligible open pool work.
8. Every outbound SOR customer dropoff (sale/rental/split/group) offers optional
   handwriting capture. Clear/cancel/skip work; signature absence never blocks.
9. Online/offline completion preserves signature image, optional signer, time and
   covered SOR refs. Drafts survive refresh; retries are idempotent; stale/cross-driver
   uploads cannot attach evidence. Signatures never satisfy required photo counts.
10. Driver/Dispatch history can read authorized signatures and archiving retains
    them. Old clients without signatures remain compatible; pending evidence survives
    PWA upgrade. Existing split, Pick-Up, stock-return and non-SOR behavior survives.

## Failure model / setup

Tier 3: wrong classification/routes (table/property tests), duplication/lost updates
(database concurrency and unique constraints), stale quantities (split/group tests),
retroactive edits (activity preservation), missing evidence or unauthorized access
(real API/offline/browser tests), partial writes (transaction rollback rehearsal),
silent sync failure (durable queue and error-state assertions).

Existing Node 20 / PostgreSQL 18 images, fast-check, c8, ESLint, TypeScript and
Playwright; no new runtime dependency or commits. Capture the dirty workspace
baseline and deploy only this task's delta onto the captured live image. Record
zero new failures against baseline, changed-line coverage, manual mutations and
property-only mutation results, browser checks, source hashes and deployment proof.
No NetSuite transaction writes or financial return/credit automation.

## Approved addition: signature wording and preview

The user requested a signature wording editor and preview on the same SOR Admin
page during implementation. Provide a global SOR signature wording setting with
revision checks, audit, and a live preview. Default: “I acknowledge receipt of the
items listed for this delivery.” Each captured signature freezes the wording and
revision from the driver's manifest; subsequent edits never rewrite evidence.

The user clarified the interaction: a Customer signature button opens a popup
showing the Admin-configured T&C and signature area. Admin previews that same
popup. Signature remains optional; Save requires actual pen strokes, while
Cancel/skip never block delivery. Treat the wording setting as the T&C body.

The SOR shell uses cache generation v43 and `20260924-sor-v1` for changed
Driver and Dispatch review assets. The existing asset contract retains every
cache-consistency assertion with these new version pins and adds the three SOR
popup assets. The offline protocol version and pending IndexedDB evidence stay
compatible.

The source-sync location list retains every existing yard and adds Rental
location 50, scoped to SOR in its SuiteQL delivery query. The existing Voyage
location-list contract now includes 50; its Voyage address and cargo assertions
remain unchanged.
