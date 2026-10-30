# Operator planning popup repair and audit

Spec approval: not obtained (autonomous run). The user requested popup logging
and fixes for the TOB01263 findings. Tier 2 bug fix with timing and access checks.

Acceptance cases:

1. A newly planned TO with an empty parking spot displays its popup.
2. A save followed by delayed dependency completion refreshes notifications and
   displays the newly planned linked TO, without waiting for another order event.
3. Explicit group references do not suppress newly changed linked TO notices.
4. Repeated refreshes of the same notification version do not redisplay a
   dismissed popup. A new truck/load/planning version can alert again.
5. Record queued, displayed, opened and dismissed in the existing Control audit,
   with authenticated operator, order, yard, client time, server time and the
   assignment shown. Displayed means the in-app banner was rendered in a visible
   document; it is not proof of human attention or OS notification delivery.
6. Retry transient audit failures while the same session remains active, without
   interrupting the popup. Duplicate receipts within 48 hours write once, even
   with concurrent retries. No credentials or arbitrary client properties enter
   the semantic audit record.
7. Anonymous, unauthorized-yard, wrong-order-yard and malformed submissions fail.
   Client input cannot change the audit actor or canonical order reference.
8. Hidden documents queue the alert; displayed is recorded only after visibility.
   Dismiss/open records identify the popup instance, not just the order.
9. Existing delivery refresh, yard access, packing and service-worker contracts
   remain intact. No order/plan quantities or production data are changed by tests.

Setup: existing Node test runner, Playwright, ESLint, TypeScript and c8; no new
dependencies, schema changes or commits. Keep narrowly scoped edits over the
current live source. Run isolated Compose with mbbs-tests.slice and the repository
retention wrapper; remove all test output, containers, volumes and networks.
Persist a reproducible check command and concise evidence. Use an app-only
release with source-drift checks, health verification and rollback.

Failure model: an early refresh misses a late assignment (browser timing test),
blank optional fields suppress a notification (browser regression), explicit
group references hide linked orders (browser regression), duplicate/reordered
events produce repeated popups or audit rows (browser and concurrent HTTP tests),
hidden tabs overstate display (visibility test), an audit outage blocks work
(browser failure/retry test), client data forges actor/yard/order (HTTP adversarial
tests), and deployment includes unrelated edits (scoped patch and runtime hashes).
