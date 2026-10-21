# Delivery timeslot negotiation and OS alerts

Run autonomously under the old-coder skill, Tier 3 (concurrent workflow changes).
Spec approval: not obtained (autonomous run).

1. A secured request keeps its confirmed window, linked Sales Orders, pricing,
   secured timestamp and stopped expiry clock throughout negotiation.
2. Sales can request a new window. Dispatch receives a popup on any staff screen.
3. Dispatch can counter a pending request. Sales can accept the counter, keep the
   secured window or request another window. Only the receiving team can accept.
   A Dispatch counter becomes authoritative only after Sales accepts it.
4. Missing pending changes, wrong teams, invalid windows, stale revisions and
   conflicting concurrent replies fail without partially changing delivery.
   Operation retries remain idempotent and updates retain history and alerts.
5. Alert popups can also display OS notifications with a same-origin link to the
   relevant request. Notification permission requires an explicit user click;
   denial, unsupported browsers and failed notification delivery leave popups usable.
6. Background delivery updates can raise OS alerts without opening a hidden-tab
   dialog. Returning to the screen displays the queued popup. Refreshing,
   reconnecting or another tab must not repeatedly alert the same revision.
7. Logging out or switching accounts must prevent notifications from the prior
   session. Alert popups continue respecting open forms and displayed revisions.

Setup: use existing Node, Playwright, fast-check, ESLint, TypeScript and c8 tools.
No new dependencies or git commits. Preserve the existing dirty workspace and
save a task-specific before snapshot and evidence. Use isolated, bounded tests in
mbbs-tests.slice; register teardown before launch and verify Docker cleanup and
production health. Production deployment requires a separate authorized step.

Failure model: premature scheduling is checked through domain and planning
integration tests; double replies through database races and retries; lost alerts
through real browser background/event tests; duplicate/session leakage through
notification tests. Lint, types, coverage, property tests and selected mutations
supplement the delivery and alert regression suites. OS notification behavior
outside the running application is pending the requested user preference.

User clarification: OS notifications are required while MBBS is open, including
background tabs. No closed-application push subscription is needed.

Additional user requirement: new requests select Single trip, Round trip or
Multi-stop trip. A round trip adds the reverse route from drop-off to pickup.
Each multi-stop leg records pickup, drop-off and quantity. All route changes
invalidate the quote; server-owned rate, capacity and route evidence determine
every leg's charge. Saved requests and Dispatch show the route breakdown.
Existing requests and API clients without a trip type retain single-trip pricing.
Pickup address rules and round-trip return quantity await the requested details.

User clarifications supersede the route examples above: a multi-stop route starts
at an MBBS yard and its last drop-off is an MBBS yard. Intermediate endpoints can
be arbitrary addresses. The round-trip return is charged as exactly one truck
trip regardless of outbound quantity. UI yard selectors and server validation
enforce both route endpoints; all yard route evidence is checked before saving.
