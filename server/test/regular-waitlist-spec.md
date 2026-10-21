# Regular Waitlist acceptance specification (Tier 3)

Approved: the user approved the complete conversational plan with “Implement the plan.”

## Setup and failure model

Use existing Node, PostgreSQL, Playwright, ESLint, TypeScript, c8 and fast-check tools in cached Docker test images. Create a dedicated `mbbs-waitlist-review` network/database/runner; NetSuite access is disabled there. Add no dependencies, make no commits, and preserve unrelated workspace changes. Capture the starting source and test failures before implementation. Persist a reproducible runner, gauntlet, mutation checks and evidence. Validate migrations only in the isolated database before any scoped release.

Failures to prevent: concurrent over-allocation (real PostgreSQL race tests), duplicate capacity from PO splits (source-line budget tests), duplicate SO creation after lost responses/restarts (network-boundary recovery tests), release during SO creation (claim/release races), timers releasing the wrong customer (clock and competing-demand tests), wrong units or pricing (payload contracts), unauthorized edits (authenticated HTTP), unread notices repeated by retries (event/ack tests), and slow local submission (HTTP benchmark). Existing regular workflows are regression constraints.

## Named acceptance scenarios

1. Local submission accepts one active NetSuite customer, one inventory item and a positive sales-unit quantity, even at zero stock and without a source yard; no remote call is made and submission completes under one second.
2. Invalid customer, multiple items, invalid quantity/unit or an unauthorized selling yard fails without creating a request. Customer, item, yard and requested quantity cannot be edited after submission.
3. A PO/item pool of 5,000 SQFT can allocate 600 and 400 to different requests; 4,000 remains available. Receiving yard and Dispatch allocations do not change this balance.
4. Parent PO and split-PO pools share canonical source capacity; cancelled/inactive/amended PO evidence cannot authorize unsupported stock.
5. UNI/BWS suggest 3445 first; PER/TH suggest 2967 first; original submission time orders each tier. Bypassing an eligible higher-ranked request requires an audited reason.
6. Partial allocation/conversion of 600 from a 1,000 request leaves 400 waiting on the same ID and original submission time, or closes that remainder when Sales chooses Close.
7. Sales closing an allocated request immediately returns all unused holds, closes remaining demand, and never releases previously converted quantity.
8. SCM cannot release at 29:59; at 30:00 it can release the full selected unused allocation with a reason. Other holds retain their own timers.
9. At 3:00:00 an unused hold automatically releases only if another open same-item request needs unallocated quantity. The request's own remainder, closed requests, other items and fully allocated requests do not trigger release.
10. An over-three-hour hold with no competitor remains convertible. Later competing demand makes it eligible on the next 15-second check. Released requests immediately remain eligible at their original queue age.
11. Returned stock stays in its existing PO/item pool; SCM sees a notice and confirms reallocation. Returned quantities are included in Available exactly once. No automatic allocation occurs.
12. Sales chooses Pickup or Delivery at conversion. Create one ordinary-item SO at the selling yard for all current held quantity, with correct NetSuite units and native pricing; omit custom price/rate. Delivery requires its address and date and supports contact/window/instructions.
13. Close, allocate, manual release, expiry and conversion serialize; stale revisions/idempotency conflicts fail atomically. Duplicate successful commands do not create additional holds, releases, notices or SOs.
14. Before the remote create, persist the conversion and marker. A lost/uncertain create response keeps stock claimed and recovers the existing marker, never blindly reposting. Restart recovery preserves that rule.
15. Definitive pre-create validation failure leaves the request open and its original allocation deadline intact. A successful SO consumes its quantity permanently in the waitlist ledger.
16. After successful conversion, later SO edits/cancellation/fulfillment do not sync back or write descriptions. Only immutable creation references/quantities remain.
17. Allocation/release sends one requester-only unread Sales notice per event. Opening the request acknowledges the displayed event. SCM returned-stock notices deep-link to the pool.
18. Existing Pickup, Delivery, Transfer/Purchase Stocking and Stocking Resolve retain their behavior; waitlist cannot enter their approval/TO/handoff paths. Existing Sales/SCM authorization applies.

## Evidence requirements

Run all new scenarios and the existing affected suites, compare full-suite failures against baseline, static checks, browser/HTTP execution, changed-line coverage, properties, five meaningful manual mutants (also against properties where relevant), and deterministic shuffled test order. Report uncovered paths or unavailable checks explicitly. Deployment checks create no production SOs.
# Native NetSuite boundary clarification

Transaction line units use the verified scalar NetSuite unit ID, consistent with the existing native REST adapter. This clarifies wire representation without changing the requested sales UOM or quantity.

## Requested enhancements — 2026-10-02

Authorization: the user directly requested filters/sorting, per-row SCM rejection, the three recent queued POs, and Delivery conversion with only date and method. Routine details below are resolved autonomously within that scope; separate approval of this expanded specification was not obtained. The original approved specification remains recorded above. Scenario 12's address/contact/window/instructions requirement is superseded only for waitlist conversion by this request.

Keep the same isolated tools and dependencies; add none and make no commits. Capture the current deployed feature and full-suite baseline before changing application code. Retain this enhancement's independent release/evidence directory. Run the nine original test files plus enhancement tests, full-suite comparison, static checks, changed-line coverage, manual mutations, generated filtering/sorting properties, and real HTTP/browser checks. Deploy only the validated delta over a fresh live capture; no production test SOs.

Failure model: rejection during an uncertain SO create could release committed stock (real transaction/HTTP races); retried rejection could duplicate notices/returns (idempotency); missing reason or unauthorized rejection could discard demand (validation and role tests); misleading recent-PO rows could suggest cancelled/received/inactive split supply (real database evidence); filters/sorts could omit or mutate requests or change allocation priority (properties and browser refresh/priority checks); simplification could overwrite a customer's address or custom notes or map the date incorrectly (native payload contracts).

19. All waiting requests support combined filters by selling yard, canonical item vendor, item and customer. All means all open waitlist demand, including partially or fully held requests and protected conversions. Changing filters never changes records or the SCM allocation priority. Clearing filters restores the list. Refresh preserves active filters/sort.
20. Sort ascending/descending by request reference, customer, vendor, item, selling yard, submitted date and requested/waiting/allocated quantities. Text sorts naturally and quantity sorts numerically. Ties retain original submission time and request ID; the source rows are not mutated.
21. Every waiting row has Reject. Confirming requires a reason and the current revision. SCM write authorization is required. Rejection closes remaining demand, immediately releases all unused holds to their existing pools, preserves committed SO quantity/references, and creates one auditable unread rejection notice to Sales. Retrying the identical command creates no duplicate release or rejection notice. Missing reason, stale revision, changed command details and rejected/completed requests cannot silently alter demand.
22. A pending/preparing/submitted/uncertain conversion blocks rejection. Reject/convert races serialize so only one claims the demand. Existing Sales Close, SCM 30-minute release and three-hour competing-demand release rules continue unchanged.
23. Each waiting row shows at most the three most recently queued active source or split POs containing its item, with PO reference and ETA. Queue order uses the recorded SCM queued time, falling back to split creation/source sync or transaction date. Exclude non-Queued schedule status, cancelled/closed/inactive POs or lines, received item lines and inactive split records. Multiple matching lines do not duplicate a PO. This is viewing evidence only: it neither creates a pool nor reads/subtracts Dispatch PO-to-SO allocations.
24. For Delivery conversion, require only a valid delivery date and the selected method. Map date to NetSuite `custbody4` (To be delivery by) and method to `custbody3`. Omit shipping address overrides and `custbody7`; obsolete extra fields are ignored. Pickup, native item/customer pricing, verified selling-yard units, all-held-quantity conversion, marker recovery and remainder handling remain unchanged.
25. Real Sales browser conversion shows only the method and delivery-date fields (plus the existing remainder choice where needed). A rejected invalid date preserves the entered draft and held quantity and displays the error. SCM filters, sorting, PO evidence and rejection are usable on desktop and phone without page-wide horizontal overflow.

Validation note, 2026-10-02: the first full enhancement run hit a pre-existing random-date fixture collision in `driver-pwa-historical-assist-concurrency.test.js` (`23505`, `idx_dispatch_plans_plan_date`). Its test and application source are unchanged. Preserve that failed run, replay the unmodified fixture four times on both the original baseline and staged candidate, and repeat the unchanged full suite. Do not suppress the failure, broaden assertions, or repair the unrelated fixture as part of this change.

Deployment instruction, 2026-10-02: the user said “do not deploy first.” Finish local implementation and validation; leave the enhancement release staged for review. No deployment is authorized by this continuation.
