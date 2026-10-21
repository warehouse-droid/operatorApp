# Exact SO quantity rejection message

Explicit user requirement: request 760 / SO 912 is an intentional edge-case test; the app must reject with a precise message. No order or request quantity is to be changed.

Given approved item TH-COV60T-1530-AUB at 760 EACH and SOB121631 at 912 EACH, reject before any handoff/TO/location write with:

> Quantity mismatch for TH-COV60T-1530-AUB: the stock request approves 760 EACH, but SOB121631 has 912 EACH. Quantities must match before linking the SO.

Keep HTTP 409 / REGULAR_SO_MISMATCH. Report both quantities, item and SO identity for over- and under-quantity mismatches. Preserve exact-row selection when several same-item SO lines require disambiguation; do not replace an ambiguous-row instruction with an inaccurate total-quantity error. Preserve all header and non-stock rules from the preceding release.

Tier 3, same financial/concurrency failure model: a message-only correction must not weaken exact matching, create handoff state for rejected input, or issue external writes. Unit/property assertions cover exact text and retained guards; real HTTP integration asserts the error and zero writes/persisted handoff. Use the existing pinned isolated Docker tools, no dependencies/schema/UI changes, and deploy only the domain file after fresh tests, lint/types/coverage/mutation checks. Validate the exact intentional live edge case read-only afterward.

## Scope addition from Sales confirmation request

The user subsequently requested a confirmation popup before routing, and readable action details when reopening the request. This supersedes the earlier no-UI-change / domain-only release scope.

- Preview validates the SO and returns the exact location-change or transfer action, with SO number, source/destination yard(s), and affected line/TO counts. Invalid quantities fail with the precise message before any confirmation.
- Sales can cancel without creating a handoff or writing an order. Confirm executes once. Changing the previewed SO, action, or line snapshot requires a new preview; selected ambiguous lines must be included in the preview.
- Save the action with the request, completion time and issued TO references. The Sales request shows these details after reload; old completed requests have a readable fallback using existing request/transfer data.
- Preserve retry recovery, authorization, revision and concurrency controls, PALLET/discount/subtotal/fee behavior, and transfer idempotency. No live order data changes during verification.
- Failure model: stale preview changes intended action (snapshot token + integration test); cancel or invalid quantities write (HTTP zero-write and browser tests); repeated confirmation duplicates order (existing retry tests); saved result disappears on reload (DB/API plus browser reload assertions); untrusted text executes HTML (escaped rendering tests).
- Reuse pinned Docker test/browser tools and existing JSON fields, with no dependencies or migrations. Deploy only verified runtime files over the currently deployed image, with health checks and rollback. Spec approval: not obtained (autonomous run); behavior is explicitly requested by the user.

## Follow-up: unreadable error object

The user reported `[object Object]` during testing. Sales must extract human-readable error text from plain error strings, nested `{error:{message,code}}` responses and top-level `{message,code}` responses. Unknown objects must produce a useful HTTP-status fallback, never object coercion. Preserve HTTP status and the error code. A browser test must reproduce a structured failure during confirmation and show the exact message, allow retry, and issue no order on the failed attempt. This uses the same scoped UI files, with another asset version to refresh an already-open test session.
