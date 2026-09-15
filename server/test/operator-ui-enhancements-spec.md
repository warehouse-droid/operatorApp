# Operator UI enhancements — approved executable specification

The user approved the plan on 2026-09-11, chose confirmed plus remaining quantities,
and chose absolute adjustment totals. The initial scope additions were Cycle
Count's Menu placement and **no deployment**. After implementation and validation,
the user explicitly authorized deployment with a short cutover and post-checks.

## Acceptance scenarios

1. Receiving and Cycle Count each have one Menu button in the top-right header.
2. Receiving number/product searches retain their input nodes, focus and selection
   across result refreshes. Older list/detail/suggestion responses cannot replace
   newer results or steal focus, including clearing and navigation.
3. A pickup of 20 pieces, confirmed for 5, shows green confirmation styling,
   `Confirmed 5`, `Remaining 15`, and an editor containing 5. The confirmation
   message says the quantity can still be adjusted before Loaded (English/Chinese).
4. Confirming 5 again keeps 5. Setting 7 yields 7 confirmed and 13 remaining.
   Setting zero clears that line. Page confirmation applies the same semantics.
5. Previously loaded quantities reduce availability. Loading the confirmed 7
   clears its draft; opening the next pickup shows the outstanding 13.
6. Pickup display is independent of Delivery Prep's saved packed/active view.
7. Existing API requests without quantityMode stay additive. The new UI sends
   quantityMode=absolute in the single body or each batch line's values.
   Unsupported modes return HTTP 400 without changing quantities.
8. Keep existing quantity conversion, availability bounds, posting guards, photo
   requirements, response envelopes and partial batch failure reporting.
9. Updated asset versions match the Operator HTML and service-worker precache.

## Failure model and validation

Tier 3 for the quantity/API change: accidental addition or double submission;
incorrect remaining/loaded arithmetic; stale asynchronous search responses;
clearing failures; legacy-client incompatibility; stale installed assets.
Use database and HTTP regressions, real browser interaction, property checks and
targeted mutants. Baseline existing failures and require zero new failures.

Use existing Docker, Node, PostgreSQL, Playwright, fast-check, c8, TypeScript and
ESLint dependencies. Add focused tests, an isolated Compose overlay, a reproducible
gauntlet and an evidence report. No new dependencies, schema migrations or commits.
Only the dedicated mbbs-operator-ui-test project is disposable. The subsequent
authorized production cutover and post-checks are recorded in
[operator-ui-enhancements-evidence.md](operator-ui-enhancements-evidence.md).
