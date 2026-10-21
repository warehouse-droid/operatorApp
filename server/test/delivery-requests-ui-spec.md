# Delivery request UI acceptance criteria

Spec approval: not obtained (autonomous run). The user authorized the concrete
behaviors below in this conversation; this spec is available for later review.
Tier 3 verification is scoped to quote-origin selection and the new status query.

1. Sales New request and Refresh are in page content. Dispatch Refresh is in
   page content; Dispatch cannot create requests. Menu and Logout remain in the
   navigation header. Refresh preserves the current draft and selected filters.
2. At desktop widths, Requesting yard, Load type and Customer share one row for
   both POS and BIN. Requested date, Start time and End time share one row.
   BIN size remains available on the following row. Narrow screens stack fields
   without horizontal overflow.
3. The document scrolls vertically to the form's lower fields and submit/close
   actions, including with the sidebar expanded and on a phone.
4. There is no Distance pricing origin input. Quotes and submissions derive it
   from the first physical outbound yard. Changing, adding or removing yards
   invalidates the previous quote. Every supported outbound yard and multi-yard
   combination retains the existing backend rate and consolidation rules.
5. Status is a checkbox filter. Selecting Awaiting Dispatch and Secured includes
   both, excluding other statuses. Clearing every checkbox includes all statuses.
   Search and Refresh retain all selected statuses. Repeated status query values
   work for Sales and Dispatch; a legacy single status still works. Status queries
   preserve yard access restrictions and parameterized search. Invalid status
   text never widens access; oversized/non-text values are rejected as before.
6. Delivery trip rows show the entered delivery address, including
   `150 → 1210 Pelican Pass, Oakville, ON L6H 7G1`, in draft quotes and saved
   requests. Transfer rows still show the destination yard. Addresses are escaped
   as text; pricing amounts, distances and trip capacity remain unchanged.

Failure model and checks:

- Wrong or stale origin causes an incorrect quote: browser payload checks for
  all four yards, randomized multi-yard orders, edit/re-raise and recalculation;
  existing pricing properties and quote-ticket integration tests.
- Multiple selected statuses accidentally return no records or unauthorized
  records: browser request checks plus real HTTP/database union, search and yard
  restriction checks; hostile query values.
- Global CSS clips the form or breaks phone layout: browser geometry, wheel
  scrolling, bottom-action visibility, screenshots and horizontal bounds.
- Address text injects markup or a transfer destination is lost: browser text
  and no-injected-element checks, plus mixed transfer/delivery rendering.
- Deployment includes unrelated work: exact live-source baseline, four-file
  overlay, runtime source hashes, app configuration and dependency identities,
  app-only release with a rollback image retained.

Setup: use existing Node, Playwright, fast-check, c8, ESLint and TypeScript in the
repository's disposable test image. Add acceptance tests and repeatable UI check,
mutation and isolated Compose entry points; store logs/screenshots/coverage in
test-artifacts. No dependencies, schema migrations, git commits or production
data changes. Tests use mbbs-tests.slice, bounded resources, a teardown registered
before launch and docker compose down --volumes --remove-orphans. Production
containers and rollback/audit artifacts are outside test cleanup.

User-requested addition: alert repair

7. A newly proposed time or pre-approval produces an unread badge and popup,
   including when the same request is already open at an older revision. Only
   revisions already displayed are suppressed. Opening/refreshing the request
   acknowledges the displayed revision, while closing a popup retains unread
   status. Existing dialog deferral, role isolation and logout cleanup survive.

Additional failure mode: the page identifies only an open request ID and
suppresses every later update for it. Browser tests exercise older, equal and
newer displayed revisions, including real event invalidations and the actual
delivery page. HTTP tests confirm proposed/preapproved unread receipts.

Release scope revision: six runtime files, adding the alert module and its
sidebar cache version to the originally listed four files.

Responsive layout clarification: on phones (up to 760px), the sidebar uses its
compact icon layout so the form uses the available width. Desktop sidebar
preferences are retained. The phone scroll test checks usable panel width.
