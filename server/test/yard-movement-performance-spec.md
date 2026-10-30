# In/Outbound loading and search performance — 2026-10-22

Scope: Control, Sales and Dispatch In/Outbound Record. The user explicitly
requested Playwright delay testing. Spec approval: not obtained (autonomous run).
Tier 3 for preserving scoped operational history and concurrent browser reads.

- P1: Global order/item searches and opening a selected order preserve the same
  rows, quantities, documents, photos, driver events and CSV identity. Existing
  PO parent/split aliases, whitespace/case matching and driver precedence remain.
- P2: Detail reads filter driver references to the selected order's aliases
  before matching history. In a fixture with 400 unrelated driver jobs, the
  selected order's driver-reference intermediate contains only its matching
  reference. PO lookups use existing normalized-reference indexes.
- P3: Playwright measures initial display, search-to-results, search-to-detail
  and click-to-detail on all three real HTTP pages with synthetic operational
  data. Record baseline and final medians/p95; target search and click p95 below
  1,000 ms on the isolated host, with no imposed network delay. Record separately
  the production read-only query baseline, whose global search/detail exceeded
  the diagnostic four-second statement timeout.
- U1: Clicking an order immediately highlights it and shows loading feedback.
  A slow prior selection never overwrites a later selection. Duplicate clicks
  while the same detail is pending do not issue duplicate requests.
- U2: Search input cancels superseded requests; clearing/changing a search or
  switching tabs invalidates older results even during debounce. Genuine errors
  remain visible and retry works. Data is fresh after explicit refresh.
- U3: Opening Control In/Outbound requests only its own data and authentication;
  unrelated admin/stock/returns panels do not delay the selected page.
- A1: Sales store and Dispatch physical-yard scope remain enforced server-side.
  Unauthorized/unknown orders return no detail. Empty scopes deny all records.
  No changes to stock, posting, reload authorization or stored count data.

Failure model: overly broad early filters can lose aliases or change collision
precedence (database regressions/properties); latest-response races can show the
wrong order (Playwright delayed responses); narrower queries can leak across
roles (real HTTP scope tests); faster reads can omit evidence (fixture parity and
existing history/reload harness); query work can scale with unrelated records
(actual PostgreSQL plans and browser timing). No production data is copied into
synthetic tests. No live mutation endpoints are exercised.

Setup: existing Node, PostgreSQL, Playwright, fast-check, c8, ESLint and TypeScript;
no new dependencies, no git commits. Add focused tests, a bounded disposable
runner, mutation checks and concise evidence. Use mbbs-tests.slice and the
standard isolated Compose settings, register teardown before setup, and remove
all disposable databases, containers, networks and generated artifacts on exit.

2026-10-22 clarification after RED: U3 excludes the shared navigation, alert and
event-stream requests. These belong to the persistent application shell; the
assertion still forbids every unrelated Control panel request observed in RED.
P3 polls completed browser resources at 10 ms instead of Playwright's growing
default interval, which can add 500 ms to measured latency. The 1,000 ms budget
is unchanged. Baseline values used the original, less precise polling.
