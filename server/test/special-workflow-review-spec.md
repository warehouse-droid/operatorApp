# Special workflow revision — approved 2026-09-24

The conversation plan and “Implement the plan” authorize this executable spec.
Tier 3: orders, exact repeated-item line identity, concurrency, and scoped cleanup.
Use existing Node/PostgreSQL/Playwright/fast-check/c8/ESLint tooling. No new
dependencies or checkpoint commits. Keep unrelated working-tree changes.

## Acceptance cases

1. Exactly seven stages; pending SCM replies -> new_enquiry; all replies ->
   await_customer_confirmation; accepted unavailable items -> wait_for_production
   even with SO/PO; ready SO -> confirmed; ready PO requiring transport ->
   dispatch_arrangement; physical customer receipt -> completed; closure -> closed.
2. Initial delivery method is mandatory. Delivery address/contact are mandatory;
   scheduling and instructions optional. Yard pickup retains the inquiry yard.
3. Acceptance needs no mapping. SO preparation pins all material items to 2055,
   captures description, sales unit/quantity/rate, and retains distinct lines.
4. Required integer pallet total: zero omits PALLET; three creates one item 1784
   line of quantity three. Duplicate saves never duplicate it; Dispatch respects zero.
5. SCM can revise ETA and confirm readiness without losing accepted decisions.
   Alerts start three weekdays before ETA in Toronto and stay active after ETA
   postponement or a not-ready check. Readiness and terminal outcomes clear alerts.
6. SCM description edits before PO creation update the exact SO line first,
   preserving price/quantity/other lines. Recover after partial success; uncertain
   order creation never blindly repeats. An unapproved SO cannot release a PO.
7. Filters OR selected stages before pagination. Empty selection means all.
8. SCM no-stock/no-ETA closure and Sales decline closure require reasons; live
   order cancellation safeguards, access restrictions, and cost privacy survive.
9. Vendor collection, yard customer collection, and delivery completion are
   distinguished from inbound receipt and truck loading. Production blocks transport.
10. Seven labelled retained examples are created entirely through frontend
    actions in a persistent isolated app. Directory fixtures and only the external
    NetSuite boundary may be simulated. Capture stage, traces, screenshots, refs.
11. Back up and remove only production SPREQ-000001 (id 17, revision 2) while
    still without orders, handoffs, media, or in-flight operations. Changed identity
    or dependencies abort removal; deletion is transactional and backup is private.

## Failure model / evidence

- Duplicate orders and partial writes: marker recovery and injected failure tests.
- Wrong repeated MBBS-Special line: distinct line keys, strict identity/conflict tests.
- Premature dispatch/completion: transition and integration tests for each method.
- Lost reminders and incorrect dates: boundary and property tests with explicit clock.
- Races/unauthorized writes: revision conflicts and role/yard integration tests.
- Destructive cleanup: exact identity/dependency guard plus restorable snapshot.
- UI-only false confidence: browser drives real application routes/repository;
  NetSuite remains explicitly simulated, with production transport contracts tested.

Run focused regression/integration/browser suites, lint/syntax/types where supported,
coverage, deterministic manual mutations, and preserve reproducible evidence. Report
baseline failures and every unrun layer honestly; no production NetSuite test writes.
